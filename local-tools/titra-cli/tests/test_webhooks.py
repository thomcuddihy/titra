from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path

import httpx
import pytest

from titra_cli.errors import (
    AuthenticationError,
    ConfigurationError,
    OutcomeUnknownError,
    RemoteApiError,
)
from titra_cli.webhooks import (
    MAX_RESPONSE_BYTES,
    decode_secret,
    deliver_webhook,
    parse_json_body,
    read_secret_file,
    sign_webhook,
)

ENDPOINT = "0123456789abcdef0123456789abcdef"
SECRET_BYTES = bytes(range(32))
SECRET = base64.urlsafe_b64encode(SECRET_BYTES).decode().rstrip("=")
BODY = b'{"event":"done","user":{"id":"u1"}}'


def test_sign_webhook_matches_exact_server_contract() -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
        request_id="request_123456789",
    )
    expected = hmac.new(
        SECRET_BYTES,
        b"1800000000." + BODY,
        hashlib.sha256,
    ).hexdigest()
    assert signed.signature == f"v1={expected}"
    assert signed.headers == {
        "Content-Type": "application/json",
        "X-Titra-Webhook-Timestamp": "1800000000",
        "X-Titra-Webhook-Event-Id": "event-1",
        "X-Titra-Webhook-Signature": f"v1={expected}",
        "X-Request-ID": "request_123456789",
    }
    preview = signed.redacted_preview()
    assert preview["body_sha256"] == hashlib.sha256(BODY).hexdigest()
    assert SECRET not in json.dumps(preview)
    assert preview["headers"]["X-Titra-Webhook-Signature"] == "<redacted>"
    assert signed.signature not in json.dumps(preview)


@pytest.mark.parametrize(
    ("keyword", "value"),
    [
        ("endpoint_id", "ABC"),
        ("event_id", "contains space"),
        ("secret", "not-a-secret"),
        ("timestamp", 1),
        ("request_id", "short"),
    ],
)
def test_sign_webhook_rejects_invalid_contract_values(keyword: str, value: object) -> None:
    values: dict[str, object] = {
        "endpoint_id": ENDPOINT,
        "event_id": "event-1",
        "body": BODY,
        "secret": SECRET,
        "timestamp": 1_800_000_000,
        "request_id": "request_123456789",
    }
    values[keyword] = value
    with pytest.raises(ConfigurationError):
        sign_webhook(**values)  # type: ignore[arg-type]


def test_body_must_be_bounded_utf8_json_object() -> None:
    assert parse_json_body(BODY) == BODY
    for value in (b"[]", b"not-json", b"\xff", b"{}" + b" " * (64 * 1024)):
        with pytest.raises(ConfigurationError):
            parse_json_body(value)


def test_secret_decoder_requires_canonical_32_bytes() -> None:
    assert decode_secret(SECRET) == SECRET_BYTES
    for value in (SECRET + "=", SECRET[:-1], f"{SECRET[:-1]}B"):
        with pytest.raises(ConfigurationError):
            decode_secret(value)


def test_read_secret_file_rejects_symlink_and_open_permissions(tmp_path: Path) -> None:
    secret_file = tmp_path / "secret"
    secret_file.write_text(f"{SECRET}\n", encoding="utf-8")
    secret_file.chmod(0o600)
    assert read_secret_file(secret_file) == SECRET
    secret_file.chmod(0o644)
    with pytest.raises(ConfigurationError, match="0600"):
        read_secret_file(secret_file)

    if os.name == "posix":
        secret_file.chmod(0o600)
        symlink = tmp_path / "secret-link"
        symlink.symlink_to(secret_file)
        with pytest.raises(ConfigurationError, match=r"securely open|non-symlink"):
            read_secret_file(symlink)


@pytest.mark.skipif(os.name != "posix", reason="POSIX descriptor and owner guarantees")
def test_read_secret_file_reads_the_open_descriptor_after_path_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret_file = tmp_path / "secret"
    replacement = tmp_path / "replacement"
    replacement_secret = base64.urlsafe_b64encode(bytes(reversed(range(32)))).decode().rstrip("=")
    secret_file.write_text(f"{SECRET}\n", encoding="utf-8")
    replacement.write_text(f"{replacement_secret}\n", encoding="utf-8")
    secret_file.chmod(0o600)
    replacement.chmod(0o600)
    real_open = os.open
    swapped = False

    def swap_after_open(path: object, flags: int, mode: int = 0o777) -> int:
        nonlocal swapped
        descriptor = real_open(path, flags, mode)
        if not swapped and Path(path) == secret_file:
            swapped = True
            secret_file.unlink()
            replacement.rename(secret_file)
        return descriptor

    monkeypatch.setattr(os, "open", swap_after_open)

    assert read_secret_file(secret_file) == SECRET
    assert swapped is True


@pytest.mark.skipif(os.name != "posix", reason="POSIX ownership guarantee")
def test_read_secret_file_rejects_a_descriptor_owned_by_another_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret_file = tmp_path / "secret"
    secret_file.write_text(SECRET, encoding="utf-8")
    secret_file.chmod(0o600)
    actual_owner = secret_file.stat().st_uid
    monkeypatch.setattr(os, "getuid", lambda: actual_owner + 1)

    with pytest.raises(ConfigurationError, match="owned by the current user"):
        read_secret_file(secret_file)


def test_deliver_webhook_sends_no_authorization_header() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") is None
        assert request.content == BODY
        assert request.headers["x-titra-webhook-event-id"] == "event-1"
        return httpx.Response(
            202,
            headers={
                "Content-Type": "application/vnd.titra.v2+json",
                "X-Request-ID": request.headers["x-request-id"],
            },
            json={"apiVersion": 2, "payload": {"accepted": True}},
        )

    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
    )
    result = deliver_webhook(
        "https://titra.example", signed, transport=httpx.MockTransport(handler)
    )
    assert result["accepted"] is True
    assert result["request_id"] == signed.request_id


def test_webhook_nested_problem_and_unknown_outcome_are_typed_without_echo() -> None:
    hostile = "REMOTE_SECRET_[bold red]\x1b[31m"
    problem = {
        "error": {
            "version": 1,
            "code": "WEBHOOK_AUTHENTICATION_FAILED",
            "category": "authentication",
            "message": hostile,
            "requestId": "server_request_1234",
            "outcome": "rejected",
            "retry": {"allowed": False},
        }
    }
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
    )
    with pytest.raises(AuthenticationError, match="authentication failed") as authentication:
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(lambda _request: httpx.Response(401, json=problem)),
        )
    assert hostile not in str(authentication.value)
    assert authentication.value.details == {
        "request_id": signed.request_id,
        "http_status": 401,
    }
    problem["error"]["outcome"] = "unknown"
    problem["error"]["message"] = hostile
    with pytest.raises(OutcomeUnknownError, match="outcome is unknown") as unknown:
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(lambda _request: httpx.Response(500, json=problem)),
        )
    assert hostile not in str(unknown.value)
    assert unknown.value.details == {
        "request_id": signed.request_id,
        "http_status": 500,
    }


def test_webhook_failure_does_not_echo_signature_body_or_hostile_request_id() -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
        request_id="request_123456789",
    )
    reflected = json.dumps(
        {
            "error": {
                "message": f"{signed.signature} {BODY.decode()}",
                "signature": signed.signature,
                "body": BODY.decode(),
            }
        }
    )
    with pytest.raises(RemoteApiError) as rejected:
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    400,
                    headers={"X-Request-ID": f"{signed.signature}\x1b[31m"},
                    text=reflected,
                )
            ),
        )
    rendered = f"{rejected.value} {rejected.value.details}"
    assert signed.signature not in rendered
    assert BODY.decode() not in rendered
    assert "\x1b" not in rendered
    assert rejected.value.details["request_id"] == signed.request_id


def test_webhook_accepts_only_bounded_safe_response_request_id() -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
        request_id="request_123456789",
    )
    with pytest.raises(RemoteApiError) as rejected:
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    400,
                    headers={"X-Request-ID": "safe_server_request_123"},
                    json={"error": {"message": "ignored"}},
                )
            ),
        )
    assert rejected.value.details["request_id"] == "safe_server_request_123"


@pytest.mark.parametrize("status", [202, 400, 500])
def test_webhook_response_body_is_bounded_and_never_reflected(status: int) -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
        request_id="request_123456789",
    )
    oversized = b"{" + b'"secret":"' + b"A" * MAX_RESPONSE_BYTES + b'"}'
    expected_error = OutcomeUnknownError if status >= 500 or status == 202 else RemoteApiError
    with pytest.raises(expected_error) as failure:
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(status, content=oversized)
            ),
        )
    rendered = f"{failure.value} {failure.value.details}"
    assert "A" * 100 not in rendered


def test_malformed_webhook_success_is_unknown() -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
    )
    with pytest.raises(OutcomeUnknownError, match="inconsistent"):
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    202, json={"apiVersion": 2, "payload": {"accepted": False}}
                )
            ),
        )


@pytest.mark.parametrize(
    ("status", "headers", "body"),
    [
        (
            200,
            {
                "Content-Type": "application/vnd.titra.v2+json",
                "X-Request-ID": "request_123456789",
            },
            {"apiVersion": 2, "payload": {"accepted": True}},
        ),
        (
            202,
            {"Content-Type": "application/json", "X-Request-ID": "request_123456789"},
            {"apiVersion": 2, "payload": {"accepted": True}},
        ),
        (
            202,
            {
                "Content-Type": "application/vnd.titra.v2+json",
                "X-Request-ID": "different_request_1",
            },
            {"apiVersion": 2, "payload": {"accepted": True}},
        ),
        (
            202,
            {
                "Content-Type": "application/vnd.titra.v2+json",
                "X-Request-ID": "request_123456789",
            },
            {"apiVersion": 2, "payload": {"accepted": True}, "extra": True},
        ),
        (
            202,
            {
                "Content-Type": "application/vnd.titra.v2+json",
                "X-Request-ID": "request_123456789",
            },
            {"apiVersion": 2, "payload": {"accepted": True, "extra": True}},
        ),
    ],
)
def test_webhook_success_requires_exact_v2_response_contract(
    status: int, headers: dict[str, str], body: dict[str, object]
) -> None:
    signed = sign_webhook(
        endpoint_id=ENDPOINT,
        event_id="event-1",
        body=BODY,
        secret=SECRET,
        timestamp=1_800_000_000,
        request_id="request_123456789",
    )
    with pytest.raises(OutcomeUnknownError, match="inconsistent"):
        deliver_webhook(
            "https://titra.example",
            signed,
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(status, headers=headers, json=body)
            ),
        )
