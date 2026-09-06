"""Durable, credential-free webhook delivery receipts and guarded replay."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .dates import parse_timestamp
from .errors import (
    ConfigurationError,
    ConflictError,
    OutcomeUnknownError,
    TitraCliError,
)
from .models import ResolvedConfig
from .output import contains_secret
from .state import StateStore, re_full_receipt_id
from .webhooks import (
    ENDPOINT_ID,
    EVENT_ID,
    REQUEST_ID,
    SignedWebhook,
    deliver_webhook,
    parse_json_body,
    sign_webhook,
)

WEBHOOK_RECEIPT_SCHEMA = "titra-cli/webhook-delivery-receipt/v1"
WEBHOOK_REPLAY_RETENTION_SECONDS = 604_800
WEBHOOK_RETRY_SAFETY_SECONDS = 600
WEBHOOK_RETRY_CUTOFF_SECONDS = WEBHOOK_REPLAY_RETENTION_SECONDS - WEBHOOK_RETRY_SAFETY_SECONDS
_RECEIPT_STATUSES = {"dispatching", "outcome_unknown", "rejected", "accepted"}
_RECEIPT_KEYS = {
    "schema",
    "receipt_id",
    "created_at",
    "updated_at",
    "first_attempt_at",
    "profile",
    "server",
    "owner_id",
    "endpoint_id",
    "event_id",
    "body_base64",
    "body_sha256",
    "status",
    "attempts",
    "result",
}
_ATTEMPT_KEYS = {
    "attempt",
    "journaled_at",
    "timestamp",
    "request_id",
    "status",
    "completed_at",
    "http_status",
}
_RESULT_KEYS = {"accepted", "status", "request_id", "event_id", "body_sha256"}


def assert_webhook_body_excludes_credentials(
    body: bytes,
    *,
    api_key: str | None,
    secret: str,
) -> None:
    """Never persist a webhook body containing either configured credential."""

    credentials = tuple(value for value in (api_key, secret) if isinstance(value, str) and value)
    for value in credentials:
        if value.encode("utf-8") in body:
            raise ConfigurationError(
                "Webhook body contains a configured credential; refusing delivery and receipt "
                "persistence."
            )
    decoded: Any = json.loads(parse_json_body(body).decode("utf-8", errors="strict"))
    if any(contains_secret(decoded, value) for value in credentials):
        raise ConfigurationError(
            "Webhook body contains a configured credential; refusing delivery and receipt "
            "persistence."
        )


def _assert_receipt_excludes_credentials(
    receipt: dict[str, Any],
    *,
    api_key: str | None,
    secret: str,
) -> None:
    """Reject any receipt field that would persist a live credential."""

    if contains_secret(receipt, secret) or (api_key and contains_secret(receipt, api_key)):
        raise ConfigurationError(
            "Webhook delivery receipt contains a configured credential; refusing persistence."
        )


def _now_utc(now: Callable[[], datetime]) -> datetime:
    value = now()
    if value.tzinfo is None:
        raise ConfigurationError("Webhook receipt clock must include a UTC offset.")
    return value.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _decode_body(receipt: dict[str, Any]) -> bytes:
    encoded = receipt.get("body_base64")
    if not isinstance(encoded, str) or not encoded:
        raise ConfigurationError("Webhook delivery receipt has no encoded body.")
    try:
        body = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ConfigurationError("Webhook delivery receipt body encoding is invalid.") from exc
    if base64.b64encode(body).decode("ascii") != encoded:
        raise ConfigurationError("Webhook delivery receipt body encoding is not canonical.")
    parse_json_body(body)
    digest = receipt.get("body_sha256")
    actual_digest = hashlib.sha256(body).hexdigest()
    if not isinstance(digest, str) or digest != actual_digest:
        raise ConfigurationError("Webhook delivery receipt body digest does not match.")
    return body


def validate_webhook_delivery_receipt(receipt: dict[str, Any]) -> bytes:
    """Validate all persisted fields and return the exact decoded body."""

    if set(receipt) != _RECEIPT_KEYS or receipt.get("schema") != WEBHOOK_RECEIPT_SCHEMA:
        raise ConfigurationError("Webhook delivery receipt is malformed.")
    receipt_id = receipt.get("receipt_id")
    owner_id = receipt.get("owner_id")
    if not isinstance(receipt_id, str) or not re_full_receipt_id(receipt_id):
        raise ConfigurationError("Webhook delivery receipt ID is invalid.")
    if not isinstance(receipt.get("profile"), str) or not receipt["profile"]:
        raise ConfigurationError("Webhook delivery receipt profile is invalid.")
    if not isinstance(receipt.get("server"), str) or not receipt["server"]:
        raise ConfigurationError("Webhook delivery receipt server is invalid.")
    if owner_id is not None and (not isinstance(owner_id, str) or not owner_id):
        raise ConfigurationError("Webhook delivery receipt owner is invalid.")
    if (
        not isinstance(receipt.get("endpoint_id"), str)
        or ENDPOINT_ID.fullmatch(receipt["endpoint_id"]) is None
    ):
        raise ConfigurationError("Webhook delivery receipt endpoint is invalid.")
    if (
        not isinstance(receipt.get("event_id"), str)
        or EVENT_ID.fullmatch(receipt["event_id"]) is None
    ):
        raise ConfigurationError("Webhook delivery receipt event ID is invalid.")
    status = receipt.get("status")
    attempts = receipt.get("attempts")
    if status not in _RECEIPT_STATUSES or not isinstance(attempts, list) or not attempts:
        raise ConfigurationError("Webhook delivery receipt attempt state is invalid.")
    request_ids: set[str] = set()
    for index, attempt in enumerate(attempts, start=1):
        if not isinstance(attempt, dict) or set(attempt) != _ATTEMPT_KEYS:
            raise ConfigurationError("Webhook delivery receipt attempt is malformed.")
        if attempt.get("attempt") != index or attempt.get("status") not in _RECEIPT_STATUSES:
            raise ConfigurationError("Webhook delivery receipt attempt sequence is invalid.")
        timestamp = attempt.get("timestamp")
        if (
            type(timestamp) is not int
            or timestamp < 1_000_000_000
            or timestamp > 9_999_999_999_999
            or not isinstance(attempt.get("request_id"), str)
        ):
            raise ConfigurationError("Webhook delivery receipt request identity is invalid.")
        if REQUEST_ID.fullmatch(attempt["request_id"]) is None:
            raise ConfigurationError("Webhook delivery receipt request identity is invalid.")
        if attempt["request_id"] in request_ids:
            raise ConfigurationError("Webhook delivery receipt request identity was reused.")
        request_ids.add(attempt["request_id"])
        journaled_at = attempt.get("journaled_at")
        if not isinstance(journaled_at, str):
            raise ConfigurationError("Webhook delivery receipt attempt timestamp is invalid.")
        parse_timestamp(journaled_at)
        completed_at = attempt.get("completed_at")
        if attempt["status"] == "dispatching":
            if completed_at is not None:
                raise ConfigurationError("Webhook dispatching attempt has a completion time.")
        else:
            if not isinstance(completed_at, str):
                raise ConfigurationError("Webhook delivery receipt completion time is invalid.")
            parse_timestamp(completed_at)
        http_status = attempt.get("http_status")
        if http_status is not None and (
            type(http_status) is not int or http_status < 100 or http_status > 599
        ):
            raise ConfigurationError("Webhook delivery receipt HTTP status is invalid.")
    for field in ("created_at", "updated_at", "first_attempt_at"):
        if not isinstance(receipt.get(field), str):
            raise ConfigurationError(f"Webhook delivery receipt {field} is invalid.")
        parse_timestamp(receipt[field])
    if (
        attempts[0]["journaled_at"] != receipt["first_attempt_at"]
        or receipt["created_at"] != receipt["first_attempt_at"]
    ):
        raise ConfigurationError("Webhook delivery receipt first-attempt identity is invalid.")
    if attempts[-1]["status"] != status:
        raise ConfigurationError("Webhook delivery receipt status is inconsistent.")
    expected_updated_at = attempts[-1]["completed_at"] or attempts[-1]["journaled_at"]
    if receipt["updated_at"] != expected_updated_at:
        raise ConfigurationError("Webhook delivery receipt update time is inconsistent.")
    result = receipt.get("result")
    if (status == "accepted") != (result is not None):
        raise ConfigurationError("Webhook delivery receipt result state is inconsistent.")
    if result is not None and (
        not isinstance(result, dict)
        or set(result) != _RESULT_KEYS
        or result.get("accepted") is not True
        or result.get("status") != 202
        or result.get("event_id") != receipt["event_id"]
        or result.get("body_sha256") != receipt["body_sha256"]
        or result.get("request_id") != attempts[-1]["request_id"]
        or not isinstance(result.get("request_id"), str)
        or REQUEST_ID.fullmatch(result["request_id"]) is None
    ):
        raise ConfigurationError("Webhook delivery receipt result is invalid.")
    return _decode_body(receipt)


class WebhookDeliveryManager:
    """Journal every delivery attempt before sending its exact signed bytes."""

    def __init__(
        self,
        config: ResolvedConfig,
        store: StateStore,
        *,
        now: Callable[[], datetime] | None = None,
        deliver: Callable[..., dict[str, Any]] = deliver_webhook,
    ) -> None:
        self.config = config
        self.store = store
        self.store.add_secret(config.api_key)
        self.now = now or (lambda: datetime.now(UTC))
        self.deliver = deliver

    def _assert_owner_mode(self, owner_id: str | None) -> None:
        if self.config.api_key and (not isinstance(owner_id, str) or not owner_id):
            raise ConfigurationError(
                "Authenticated webhook delivery requires an immutable API owner ID."
            )
        if not self.config.api_key and owner_id is not None:
            raise ConfigurationError("Server-only webhook delivery cannot claim an API owner.")

    def _assert_scope(self, receipt: dict[str, Any], owner_id: str | None) -> None:
        if receipt.get("profile") != self.config.profile or str(receipt.get("server", "")).rstrip(
            "/"
        ) != self.config.server.rstrip("/"):
            raise ConflictError(
                "Webhook delivery receipt belongs to a different profile or server."
            )
        if receipt.get("owner_id") != owner_id:
            raise ConflictError(
                "Webhook delivery receipt belongs to a different API owner or authentication "
                "mode. It was left untouched."
            )

    @staticmethod
    def _summary(receipt: dict[str, Any], body: bytes) -> dict[str, Any]:
        return {
            "receipt_id": receipt["receipt_id"],
            "endpoint_id": receipt["endpoint_id"],
            "event_id": receipt["event_id"],
            "status": receipt["status"],
            "created_at": receipt["created_at"],
            "updated_at": receipt["updated_at"],
            "first_attempt_at": receipt["first_attempt_at"],
            "body_bytes": len(body),
            "body_sha256": receipt["body_sha256"],
            "attempts": [
                {
                    "attempt": attempt["attempt"],
                    "request_id": attempt["request_id"],
                    "timestamp": attempt["timestamp"],
                    "status": attempt["status"],
                    "journaled_at": attempt["journaled_at"],
                    "completed_at": attempt["completed_at"],
                    "http_status": attempt["http_status"],
                }
                for attempt in receipt["attempts"]
            ],
        }

    def inspect(self, receipt_id: str, *, owner_id: str | None) -> dict[str, Any]:
        self._assert_owner_mode(owner_id)
        receipt = self.store.load_webhook_delivery_receipt(receipt_id)
        body = validate_webhook_delivery_receipt(receipt)
        self._assert_scope(receipt, owner_id)
        return self._summary(receipt, body)

    def list_receipts(self, *, owner_id: str | None) -> list[dict[str, Any]]:
        self._assert_owner_mode(owner_id)
        summaries: list[dict[str, Any]] = []
        for receipt in self.store.list_webhook_delivery_receipts(self.config):
            if receipt.get("owner_id") != owner_id:
                continue
            body = validate_webhook_delivery_receipt(receipt)
            summaries.append(self._summary(receipt, body))
        return summaries

    def _new_receipt(self, signed: SignedWebhook, owner_id: str | None) -> dict[str, Any]:
        instant = _now_utc(self.now)
        journaled_at = _iso(instant)
        body_sha256 = hashlib.sha256(signed.body).hexdigest()
        attempt = {
            "attempt": 1,
            "journaled_at": journaled_at,
            "timestamp": signed.timestamp,
            "request_id": signed.request_id,
            "status": "dispatching",
            "completed_at": None,
            "http_status": None,
        }
        return {
            "schema": WEBHOOK_RECEIPT_SCHEMA,
            "receipt_id": uuid.uuid4().hex,
            "created_at": journaled_at,
            "updated_at": journaled_at,
            "first_attempt_at": journaled_at,
            "profile": self.config.profile,
            "server": self.config.server,
            "owner_id": owner_id,
            "endpoint_id": signed.endpoint_id,
            "event_id": signed.event_id,
            "body_base64": base64.b64encode(signed.body).decode("ascii"),
            "body_sha256": body_sha256,
            "status": "dispatching",
            "attempts": [attempt],
            "result": None,
        }

    def _validate_retry(
        self,
        receipt: dict[str, Any],
        *,
        owner_id: str | None,
        secret: str,
    ) -> tuple[bytes, datetime]:
        if contains_secret(receipt, secret) or (
            self.config.api_key and contains_secret(receipt, self.config.api_key)
        ):
            raise ConfigurationError(
                "Webhook delivery receipt contains a configured credential; refusing retry."
            )
        body = validate_webhook_delivery_receipt(receipt)
        self._assert_scope(receipt, owner_id)
        if receipt["status"] == "accepted":
            raise ConflictError("Webhook delivery receipt is already accepted.")
        instant = _now_utc(self.now)
        first_attempt = parse_timestamp(str(receipt["first_attempt_at"])).astimezone(UTC)
        age_seconds = (instant - first_attempt).total_seconds()
        if age_seconds < 0:
            raise ConfigurationError(
                "Webhook receipt first-attempt time is in the future; refusing retry."
            )
        if age_seconds >= WEBHOOK_RETRY_CUTOFF_SECONDS:
            raise ConflictError(
                "Webhook delivery is within the final 600 seconds of the guaranteed "
                "604800-second replay retention window. The receipt was left untouched."
            )
        assert_webhook_body_excludes_credentials(
            body,
            api_key=self.config.api_key,
            secret=secret,
        )
        return body, instant

    @staticmethod
    def _sign_retry(
        receipt: dict[str, Any],
        body: bytes,
        secret: str,
        instant: datetime,
    ) -> SignedWebhook:
        return sign_webhook(
            endpoint_id=str(receipt["endpoint_id"]),
            event_id=str(receipt["event_id"]),
            body=body,
            secret=secret,
            timestamp=int(instant.timestamp()),
            request_id=None,
        )

    def _journal_retry(
        self,
        receipt: dict[str, Any],
        signed: SignedWebhook,
        instant: datetime,
        *,
        secret: str,
    ) -> None:
        journaled_at = _iso(instant)
        attempt = {
            "attempt": len(receipt["attempts"]) + 1,
            "journaled_at": journaled_at,
            "timestamp": signed.timestamp,
            "request_id": signed.request_id,
            "status": "dispatching",
            "completed_at": None,
            "http_status": None,
        }
        previous = receipt["attempts"][-1]
        if previous["status"] == "dispatching":
            previous["status"] = "outcome_unknown"
            previous["completed_at"] = journaled_at
        receipt["attempts"].append(attempt)
        receipt["status"] = "dispatching"
        receipt["updated_at"] = journaled_at
        receipt["result"] = None
        _assert_receipt_excludes_credentials(
            receipt,
            api_key=self.config.api_key,
            secret=secret,
        )
        validate_webhook_delivery_receipt(receipt)
        self.store.save_webhook_delivery_receipt(receipt)

    def _deliver_locked(
        self,
        receipt: dict[str, Any],
        signed: SignedWebhook,
        *,
        secret: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        attempt = receipt["attempts"][-1]
        try:
            result = self.deliver(
                self.config.server,
                signed,
                verify_tls=self.config.verify_tls,
                timeout=self.config.timeout,
            )
            if (
                not isinstance(result, dict)
                or result.get("accepted") is not True
                or result.get("status") != 202
                or result.get("request_id") != signed.request_id
                or result.get("event_id") != signed.event_id
                or result.get("body_sha256") != hashlib.sha256(signed.body).hexdigest()
            ):
                raise OutcomeUnknownError(
                    "Webhook delivery result was inconsistent with the journaled attempt."
                )
        except TitraCliError as exc:
            status = "outcome_unknown" if isinstance(exc, OutcomeUnknownError) else "rejected"
            completed_at = _iso(_now_utc(self.now))
            receipt["status"] = status
            receipt["updated_at"] = completed_at
            attempt["status"] = status
            attempt["completed_at"] = completed_at
            details = exc.details if isinstance(exc.details, dict) else {}
            http_status = details.get("http_status")
            attempt["http_status"] = (
                http_status if type(http_status) is int and 100 <= http_status <= 599 else None
            )
            _assert_receipt_excludes_credentials(
                receipt,
                api_key=self.config.api_key,
                secret=secret,
            )
            validate_webhook_delivery_receipt(receipt)
            self.store.save_webhook_delivery_receipt(receipt)
            exc.message = f"{exc.message} Durable webhook receipt ID: {receipt['receipt_id']}."
            raise
        completed_at = _iso(_now_utc(self.now))
        safe_result = {
            "accepted": True,
            "status": 202,
            "request_id": signed.request_id,
            "event_id": signed.event_id,
            "body_sha256": hashlib.sha256(signed.body).hexdigest(),
        }
        receipt["status"] = "accepted"
        receipt["updated_at"] = completed_at
        receipt["result"] = safe_result
        attempt["status"] = "accepted"
        attempt["completed_at"] = completed_at
        attempt["http_status"] = 202
        _assert_receipt_excludes_credentials(
            receipt,
            api_key=self.config.api_key,
            secret=secret,
        )
        validate_webhook_delivery_receipt(receipt)
        path = self.store.save_webhook_delivery_receipt(receipt)
        return {**safe_result, "receipt_id": receipt["receipt_id"], "receipt": str(path)}, receipt

    def send_initial(
        self,
        signed: SignedWebhook,
        *,
        owner_id: str | None,
        secret: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self._assert_owner_mode(owner_id)
        assert_webhook_body_excludes_credentials(
            signed.body,
            api_key=self.config.api_key,
            secret=secret,
        )
        self.store.add_secret(secret)
        receipt = self._new_receipt(signed, owner_id)
        _assert_receipt_excludes_credentials(
            receipt,
            api_key=self.config.api_key,
            secret=secret,
        )
        validate_webhook_delivery_receipt(receipt)
        with self.store.webhook_delivery_operation_lock(str(receipt["receipt_id"])):
            self.store.save_webhook_delivery_receipt(receipt)
            return self._deliver_locked(receipt, signed, secret=secret)

    def retry(
        self,
        receipt_id: str,
        *,
        owner_id: str | None,
        secret: str,
        prepared: SignedWebhook | None = None,
        expected_attempts: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self._assert_owner_mode(owner_id)
        self.store.add_secret(secret)
        with self.store.webhook_delivery_operation_lock(receipt_id):
            receipt = self.store.load_webhook_delivery_receipt(receipt_id)
            body, instant = self._validate_retry(
                receipt,
                owner_id=owner_id,
                secret=secret,
            )
            if expected_attempts is not None and len(receipt["attempts"]) != expected_attempts:
                raise ConflictError(
                    "Webhook delivery receipt changed after preview; inspect it again."
                )
            if prepared is None:
                signed = self._sign_retry(receipt, body, secret, instant)
            else:
                if abs(int(instant.timestamp()) - prepared.timestamp) > 300:
                    raise ConflictError(
                        "Webhook retry preview is older than the receiver timestamp window; "
                        "preview it again."
                    )
                expected = sign_webhook(
                    endpoint_id=str(receipt["endpoint_id"]),
                    event_id=str(receipt["event_id"]),
                    body=body,
                    secret=secret,
                    timestamp=prepared.timestamp,
                    request_id=prepared.request_id,
                )
                if expected != prepared:
                    raise ConflictError(
                        "Prepared webhook retry no longer matches the receipt and supplied secret."
                    )
                signed = prepared
            self._journal_retry(receipt, signed, instant, secret=secret)
            return self._deliver_locked(receipt, signed, secret=secret)

    def prepare_retry(
        self,
        receipt_id: str,
        *,
        owner_id: str | None,
        secret: str,
    ) -> tuple[SignedWebhook, dict[str, Any]]:
        """Build a redacted-previewable retry without modifying its receipt."""

        self._assert_owner_mode(owner_id)
        self.store.add_secret(secret)
        receipt = self.store.load_webhook_delivery_receipt(receipt_id)
        body, instant = self._validate_retry(
            receipt,
            owner_id=owner_id,
            secret=secret,
        )
        return self._sign_retry(receipt, body, secret, instant), receipt
