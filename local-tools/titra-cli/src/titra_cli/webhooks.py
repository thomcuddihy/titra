"""Signing and delivery helpers for Titra's separate v6 webhook contract.

The action-verification webhook does not use a user's API token.  Keeping its
secret and request construction outside :mod:`titra_cli.api` prevents an
Authorization header from being attached accidentally.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

import httpx

from .errors import (
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    OutcomeUnknownError,
    RemoteApiError,
)

ENDPOINT_ID = re.compile(r"^[0-9a-f]{32}$")
EVENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16,80}$")
SECRET_TEXT = re.compile(r"^[A-Za-z0-9_-]{43}$")
MAX_BODY_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class SignedWebhook:
    """An exact payload and the public headers needed to authenticate it."""

    body: bytes
    endpoint_id: str
    event_id: str
    timestamp: int
    request_id: str
    signature: str

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Titra-Webhook-Timestamp": str(self.timestamp),
            "X-Titra-Webhook-Event-Id": self.event_id,
            "X-Titra-Webhook-Signature": self.signature,
            "X-Request-ID": self.request_id,
        }

    def redacted_preview(self) -> dict[str, Any]:
        """Return useful audit data without echoing the event body or secret."""

        public_headers = self.headers
        public_headers["X-Titra-Webhook-Signature"] = "<redacted>"
        return {
            "endpoint_id": self.endpoint_id,
            "event_id": self.event_id,
            "timestamp": self.timestamp,
            "request_id": self.request_id,
            "body_bytes": len(self.body),
            "body_sha256": hashlib.sha256(self.body).hexdigest(),
            "headers": public_headers,
        }


def decode_secret(value: str) -> bytes:
    """Decode the canonical, unpadded base64url form of a 32-byte secret."""

    if not isinstance(value, str) or SECRET_TEXT.fullmatch(value) is None:
        raise ConfigurationError(
            "Webhook secret must be canonical unpadded base64url for exactly 32 bytes."
        )
    try:
        decoded = base64.urlsafe_b64decode(f"{value}=")
    except (ValueError, TypeError) as exc:
        raise ConfigurationError("Webhook secret is not valid base64url.") from exc
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if len(decoded) != 32 or not hmac.compare_digest(canonical, value):
        raise ConfigurationError(
            "Webhook secret must be canonical unpadded base64url for exactly 32 bytes."
        )
    return decoded


def read_secret_file(path: Path) -> str:
    """Read a secret from a regular private file without following symlinks."""

    resolved = path.expanduser().absolute()
    descriptor: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(resolved, flags)
        metadata = os.fstat(descriptor)
    except OSError as exc:
        raise ConfigurationError(f"Cannot securely open webhook secret file: {resolved}") from exc
    try:
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigurationError("Webhook secret file must be a regular, non-symlink file.")
        if os.name == "posix":
            if metadata.st_uid != os.getuid():
                raise ConfigurationError("Webhook secret file must be owned by the current user.")
            if metadata.st_mode & 0o077:
                raise ConfigurationError(
                    "Webhook secret file permissions must be 0600 or stricter."
                )
        assert descriptor is not None
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            raw = handle.read(257)
            if len(raw) > 256 or handle.read(1):
                raise ConfigurationError("Webhook secret file is unexpectedly large.")
        value = raw.decode("utf-8", errors="strict").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigurationError(f"Cannot read webhook secret file: {resolved}") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    decode_secret(value)
    return value


def parse_json_body(raw: bytes) -> bytes:
    """Validate an exact UTF-8 JSON object while preserving its original bytes."""

    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BODY_BYTES:
        raise ConfigurationError(f"Webhook body must contain 1 to {MAX_BODY_BYTES} bytes.")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigurationError("Webhook body must be one valid UTF-8 JSON object.") from exc
    if not isinstance(value, dict):
        raise ConfigurationError("Webhook body must be a JSON object.")
    return raw


def sign_webhook(
    *,
    endpoint_id: str,
    event_id: str,
    body: bytes,
    secret: str,
    timestamp: int | None = None,
    request_id: str | None = None,
) -> SignedWebhook:
    """Create the v1 exact-body HMAC request used by the v6 receiver."""

    if ENDPOINT_ID.fullmatch(endpoint_id) is None:
        raise ConfigurationError("Webhook endpoint ID must contain 32 lowercase hex digits.")
    if EVENT_ID.fullmatch(event_id) is None:
        raise ConfigurationError("Webhook event ID must be 1-200 safe ASCII characters.")
    exact_body = parse_json_body(body)
    key = decode_secret(secret)
    resolved_timestamp = int(time.time()) if timestamp is None else timestamp
    if (
        type(resolved_timestamp) is not int
        or resolved_timestamp < 1_000_000_000
        or resolved_timestamp > 9_999_999_999_999
    ):
        raise ConfigurationError("Webhook timestamp must be 10-13 decimal Unix seconds.")
    resolved_request_id = request_id or f"titra-cli-{uuid4().hex}"
    if REQUEST_ID.fullmatch(resolved_request_id) is None:
        raise ConfigurationError("Webhook request ID must be 16-80 safe ASCII characters.")
    digest = hmac.new(
        key,
        f"{resolved_timestamp}.".encode() + exact_body,
        hashlib.sha256,
    ).hexdigest()
    return SignedWebhook(
        body=exact_body,
        endpoint_id=endpoint_id,
        event_id=event_id,
        timestamp=resolved_timestamp,
        request_id=resolved_request_id,
        signature=f"v1={digest}",
    )


def _bounded_response_body(response: httpx.Response) -> bytes | None:
    """Read no more than one bounded, decoded receiver response."""

    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_bytes(chunk_size=8192):
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _safe_response_request_id(response: httpx.Response, signed: SignedWebhook) -> str:
    candidate = response.headers.get("x-request-id")
    if isinstance(candidate, str) and REQUEST_ID.fullmatch(candidate) is not None:
        return candidate
    return signed.request_id


def _raise_receiver_failure(status: int, *, request_id: str) -> NoReturn:
    """Raise a fixed local error without reflecting an untrusted peer response."""

    details = {"request_id": request_id, "http_status": status}
    if status in {401, 403}:
        raise AuthenticationError("Webhook authentication failed at the receiver.", details)
    if status in {409, 412, 423, 428}:
        raise ConflictError("Webhook delivery conflicted with receiver state.", details)
    if status >= 500:
        raise OutcomeUnknownError(
            f"Webhook write outcome is unknown after receiver HTTP {status}.", details
        )
    raise RemoteApiError(f"Webhook receiver rejected the request (HTTP {status}).", details)


def deliver_webhook(
    server: str,
    signed: SignedWebhook,
    *,
    verify_tls: bool = True,
    timeout: float = 20.0,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    """Deliver one signed request without ever attaching the bearer API token."""

    url = f"{server.rstrip('/')}/user/action-verification/webhook/{signed.endpoint_id}"
    try:
        with (
            httpx.Client(
                follow_redirects=False,
                verify=verify_tls,
                timeout=timeout,
                transport=transport,
            ) as client,
            client.stream("POST", url, content=signed.body, headers=signed.headers) as response,
        ):
            response_body = _bounded_response_body(response)
    except httpx.RequestError as exc:
        raise OutcomeUnknownError(
            "The connection failed during webhook delivery; its outcome is unknown.",
            {"request_id": signed.request_id},
        ) from exc
    response_request_id = _safe_response_request_id(response, signed)
    safe_details = {
        "request_id": response_request_id,
        "http_status": response.status_code,
    }
    if response_body is None:
        if 200 <= response.status_code < 300:
            raise OutcomeUnknownError(
                "Webhook delivery returned an oversized success response; its outcome is unknown.",
                safe_details,
            )
        _raise_receiver_failure(response.status_code, request_id=response_request_id)
    if not 200 <= response.status_code < 300:
        _raise_receiver_failure(response.status_code, request_id=response_request_id)
    try:
        body: Any = json.loads(response_body.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise OutcomeUnknownError(
            "Webhook delivery returned a malformed success response; its outcome is unknown.",
            safe_details,
        ) from exc
    payload = body.get("payload") if isinstance(body, dict) else None
    media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if (
        response.status_code != 202
        or media_type != "application/vnd.titra.v2+json"
        or response_request_id != signed.request_id
        or not isinstance(body, dict)
        or set(body) != {"apiVersion", "payload"}
        or body.get("apiVersion") != 2
        or not isinstance(payload, dict)
        or set(payload) != {"accepted"}
        or payload.get("accepted") is not True
    ):
        raise OutcomeUnknownError(
            "Webhook delivery returned an inconsistent success response; its outcome is unknown.",
            safe_details,
        )
    return {
        "accepted": True,
        "status": 202,
        "request_id": signed.request_id,
        "event_id": signed.event_id,
        "body_sha256": hashlib.sha256(signed.body).hexdigest(),
    }
