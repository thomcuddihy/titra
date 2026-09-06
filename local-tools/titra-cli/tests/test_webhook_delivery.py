from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from titra_cli.errors import ConfigurationError, ConflictError, OutcomeUnknownError
from titra_cli.models import ResolvedConfig
from titra_cli.state import StateStore
from titra_cli.webhook_delivery import WebhookDeliveryManager
from titra_cli.webhooks import SignedWebhook, sign_webhook

SECRET_A = "A" * 43
SECRET_B = "B" * 43
ENDPOINT = "a" * 32


class Clock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


def config(*, api_key: str = "api-token-value", profile: str = "test") -> ResolvedConfig:
    return ResolvedConfig(
        profile=profile,
        server="https://titra.example",
        api_key=api_key,
        username="Alice" if api_key else None,
        timezone="UTC",
    )


def signed(
    body: bytes = b'{"kind":"synthetic"}',
    *,
    secret: str = SECRET_A,
    event_id: str = "event-1",
    request_id: str = "initial-request-0001",
    timestamp: int = 1_780_000_000,
) -> SignedWebhook:
    return sign_webhook(
        endpoint_id=ENDPOINT,
        event_id=event_id,
        body=body,
        secret=secret,
        timestamp=timestamp,
        request_id=request_id,
    )


def accepted(value: SignedWebhook) -> dict[str, Any]:
    return {
        "accepted": True,
        "status": 202,
        "request_id": value.request_id,
        "event_id": value.event_id,
        "body_sha256": hashlib.sha256(value.body).hexdigest(),
    }


def only_receipt(store: StateStore) -> tuple[Path, dict[str, Any]]:
    [path] = list((store.root / "webhook-delivery-receipts").glob("*.json"))
    return path, json.loads(path.read_text(encoding="utf-8"))


def test_initial_delivery_is_fsynced_before_post_without_credentials(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    clock = Clock(datetime(2026, 9, 3, 1, 0, tzinfo=UTC))
    exact_body = b'{"kind":"synthetic", "number":1}'
    observed: list[SignedWebhook] = []

    def deliver(_server: str, value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        path, receipt = only_receipt(store)
        assert path.exists()
        assert receipt["status"] == "dispatching"
        assert receipt["attempts"][0]["request_id"] == value.request_id
        observed.append(value)
        return accepted(value)

    result, receipt = WebhookDeliveryManager(
        config(),
        store,
        now=clock,
        deliver=deliver,
    ).send_initial(signed(exact_body), owner_id="u1", secret=SECRET_A)

    assert result["receipt_id"] == receipt["receipt_id"]
    assert receipt["status"] == "accepted"
    assert receipt["owner_id"] == "u1"
    assert base64.b64decode(receipt["body_base64"]) == exact_body
    assert receipt["body_sha256"] == hashlib.sha256(exact_body).hexdigest()
    assert observed[0].body == exact_body
    path, persisted = only_receipt(store)
    raw = path.read_text(encoding="utf-8")
    assert persisted["status"] == "accepted"
    assert SECRET_A not in raw
    assert config().api_key not in raw
    assert "signature" not in raw.casefold()
    if os.name == "posix":
        assert path.stat().st_mode & 0o077 == 0


def test_unknown_delivery_retries_same_event_and_body_with_fresh_request_identity(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    clock = Clock(datetime(2026, 9, 3, 1, 0, tzinfo=UTC))
    attempts: list[SignedWebhook] = []

    def deliver(_server: str, value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        attempts.append(value)
        if len(attempts) == 1:
            raise OutcomeUnknownError("lost", {"http_status": 503})
        return accepted(value)

    manager = WebhookDeliveryManager(config(), store, now=clock, deliver=deliver)
    with pytest.raises(OutcomeUnknownError, match="Durable webhook receipt ID"):
        manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    _path, receipt = only_receipt(store)
    assert receipt["status"] == "outcome_unknown"
    assert receipt["attempts"][0]["http_status"] == 503

    clock.value += timedelta(hours=1)
    prepared, preview_receipt = manager.prepare_retry(
        receipt["receipt_id"], owner_id="u1", secret=SECRET_A
    )
    assert prepared.event_id == attempts[0].event_id
    assert prepared.body == attempts[0].body
    assert prepared.request_id != attempts[0].request_id
    assert prepared.timestamp == int(clock.value.timestamp())
    result, recovered = manager.retry(
        receipt["receipt_id"],
        owner_id="u1",
        secret=SECRET_A,
        prepared=prepared,
        expected_attempts=len(preview_receipt["attempts"]),
    )
    assert result["accepted"] is True
    assert recovered["status"] == "accepted"
    assert [item["status"] for item in recovered["attempts"]] == [
        "outcome_unknown",
        "accepted",
    ]
    assert len({item["request_id"] for item in recovered["attempts"]}) == 2


def test_interrupted_initial_post_remains_recoverable_by_exact_receipt(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    calls = 0

    def interrupt_then_accept(
        _server: str, value: SignedWebhook, **_options: Any
    ) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise KeyboardInterrupt
        return accepted(value)

    manager = WebhookDeliveryManager(config(), store, deliver=interrupt_then_accept)
    with pytest.raises(KeyboardInterrupt):
        manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    _path, receipt = only_receipt(store)
    assert receipt["status"] == "dispatching"

    _result, final = manager.retry(receipt["receipt_id"], owner_id="u1", secret=SECRET_A)
    assert [attempt["status"] for attempt in final["attempts"]] == [
        "outcome_unknown",
        "accepted",
    ]


def test_retry_refuses_safe_retention_cutoff_without_changing_receipt(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    first = datetime(2026, 9, 3, 1, 0, tzinfo=UTC)
    clock = Clock(first)

    def unknown(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        raise OutcomeUnknownError("lost")

    manager = WebhookDeliveryManager(config(), store, now=clock, deliver=unknown)
    with pytest.raises(OutcomeUnknownError):
        manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    path, receipt = only_receipt(store)
    before = path.read_bytes()
    clock.value = first + timedelta(seconds=604_200)

    with pytest.raises(ConflictError, match=r"final 600 seconds.*604800-second"):
        manager.prepare_retry(receipt["receipt_id"], owner_id="u1", secret=SECRET_A)
    assert path.read_bytes() == before


def test_retry_is_allowed_one_second_before_safe_retention_cutoff(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    first = datetime(2026, 9, 3, 1, 0, tzinfo=UTC)
    clock = Clock(first)

    def unknown(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        raise OutcomeUnknownError("lost")

    manager = WebhookDeliveryManager(config(), store, now=clock, deliver=unknown)
    with pytest.raises(OutcomeUnknownError):
        manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    _path, receipt = only_receipt(store)
    clock.value = first + timedelta(seconds=604_199)

    prepared, unchanged = manager.prepare_retry(
        receipt["receipt_id"], owner_id="u1", secret=SECRET_A
    )

    assert prepared.timestamp == int(clock.value.timestamp())
    assert unchanged["receipt_id"] == receipt["receipt_id"]


@pytest.mark.parametrize("credential", ["api", "secret"])
def test_initial_receipt_rejects_body_containing_a_credential(
    tmp_path: Path,
    credential: str,
) -> None:
    selected_config = config()
    leaked = selected_config.api_key if credential == "api" else SECRET_A
    body = json.dumps({"value": leaked}, separators=(",", ":")).encode()
    called = False

    def deliver(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        nonlocal called
        called = True
        return {}

    with pytest.raises(ConfigurationError, match="contains a configured credential"):
        WebhookDeliveryManager(
            selected_config,
            StateStore(tmp_path),
            deliver=deliver,
        ).send_initial(signed(body), owner_id="u1", secret=SECRET_A)
    assert called is False
    assert not (tmp_path / "webhook-delivery-receipts").exists()


@pytest.mark.parametrize(
    ("credential", "location"),
    [
        ("api-token-value", "key"),
        ("api-token-value", "value"),
        (SECRET_A, "key"),
        (SECRET_A, "value"),
    ],
)
def test_initial_receipt_rejects_json_escaped_credential_before_persistence(
    tmp_path: Path,
    credential: str,
    location: str,
) -> None:
    escaped = "".join(f"\\u{ord(character):04x}" for character in credential)
    nested = f'{{"{escaped}":"synthetic"}}' if location == "key" else f'{{"value":"{escaped}"}}'
    body = f'{{"nested":{nested}}}'.encode()
    selected_config = config()
    called = False

    def deliver(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        nonlocal called
        called = True
        return {}

    with pytest.raises(ConfigurationError, match="contains a configured credential"):
        WebhookDeliveryManager(
            selected_config,
            StateStore(tmp_path),
            deliver=deliver,
        ).send_initial(signed(body), owner_id="u1", secret=SECRET_A)
    assert called is False
    assert not (tmp_path / "webhook-delivery-receipts").exists()


@pytest.mark.parametrize(
    ("identity_field", "credential"),
    [
        ("event_id", SECRET_A),
        ("request_id", SECRET_A),
        ("event_id", "api-token-value"),
    ],
)
def test_initial_receipt_rejects_credential_in_public_identity(
    tmp_path: Path,
    identity_field: str,
    credential: str,
) -> None:
    selected = signed(
        **{identity_field: credential},
    )
    called = False

    def deliver(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        nonlocal called
        called = True
        return {}

    with pytest.raises(ConfigurationError, match="contains a configured credential"):
        WebhookDeliveryManager(
            config(),
            StateStore(tmp_path),
            deliver=deliver,
        ).send_initial(selected, owner_id="u1", secret=SECRET_A)
    assert called is False
    assert not (tmp_path / "webhook-delivery-receipts").exists()


def test_retry_rejects_loaded_body_containing_new_secret_without_mutation(
    tmp_path: Path,
) -> None:
    store = StateStore(tmp_path)
    clock = Clock(datetime(2026, 9, 3, 1, 0, tzinfo=UTC))
    escaped_secret = "".join(f"\\u{ord(character):04x}" for character in SECRET_B)
    body = f'{{"value":"{escaped_secret}"}}'.encode()

    def unknown(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        raise OutcomeUnknownError("lost")

    manager = WebhookDeliveryManager(config(), store, now=clock, deliver=unknown)
    with pytest.raises(OutcomeUnknownError):
        manager.send_initial(signed(body), owner_id="u1", secret=SECRET_A)
    path, receipt = only_receipt(store)
    before = path.read_bytes()

    with pytest.raises(ConfigurationError, match="contains a configured credential"):
        manager.prepare_retry(receipt["receipt_id"], owner_id="u1", secret=SECRET_B)
    assert path.read_bytes() == before


def test_retry_enforces_owner_and_server_only_authentication_mode(tmp_path: Path) -> None:
    store = StateStore(tmp_path)

    def unknown(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        raise OutcomeUnknownError("lost")

    manager = WebhookDeliveryManager(config(), store, deliver=unknown)
    with pytest.raises(OutcomeUnknownError):
        manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    path, receipt = only_receipt(store)
    before = path.read_bytes()

    with pytest.raises(ConflictError, match="different API owner"):
        manager.prepare_retry(receipt["receipt_id"], owner_id="u2", secret=SECRET_A)
    server_only = WebhookDeliveryManager(config(api_key=""), StateStore(tmp_path), deliver=unknown)
    with pytest.raises(ConflictError, match="different API owner"):
        server_only.prepare_retry(receipt["receipt_id"], owner_id=None, secret=SECRET_A)
    assert path.read_bytes() == before


def test_list_and_inspect_hide_receipts_from_other_owner_or_scope(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    manager = WebhookDeliveryManager(
        config(), store, deliver=lambda _s, value, **_o: accepted(value)
    )
    _result, receipt = manager.send_initial(signed(), owner_id="u1", secret=SECRET_A)

    assert manager.list_receipts(owner_id="u2") == []
    with pytest.raises(ConflictError, match="different API owner"):
        manager.inspect(receipt["receipt_id"], owner_id="u2")
    other_profile = WebhookDeliveryManager(config(profile="other"), store)
    assert other_profile.list_receipts(owner_id="u1") == []
    with pytest.raises(ConflictError, match="different profile or server"):
        other_profile.inspect(receipt["receipt_id"], owner_id="u1")


def test_server_only_receipt_can_be_retried_without_an_api_identity(tmp_path: Path) -> None:
    store = StateStore(tmp_path)
    calls = 0

    def deliver(_server: str, value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OutcomeUnknownError("lost")
        return accepted(value)

    manager = WebhookDeliveryManager(config(api_key=""), store, deliver=deliver)
    with pytest.raises(OutcomeUnknownError):
        manager.send_initial(signed(), owner_id=None, secret=SECRET_A)
    _path, receipt = only_receipt(store)
    result, final = manager.retry(receipt["receipt_id"], owner_id=None, secret=SECRET_A)
    assert result["accepted"] is True
    assert final["owner_id"] is None


def test_concurrent_retry_is_blocked_for_the_entire_network_call(tmp_path: Path) -> None:
    store = StateStore(tmp_path)

    def unknown(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        raise OutcomeUnknownError("lost")

    initial = WebhookDeliveryManager(config(), store, deliver=unknown)
    with pytest.raises(OutcomeUnknownError):
        initial.send_initial(signed(), owner_id="u1", secret=SECRET_A)
    _path, receipt = only_receipt(store)
    entered = threading.Event()
    release = threading.Event()
    failures: list[BaseException] = []

    def slow(_server: str, value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        entered.set()
        if not release.wait(timeout=5):
            raise RuntimeError("test did not release webhook request")
        return accepted(value)

    first = WebhookDeliveryManager(config(), StateStore(tmp_path), deliver=slow)
    second_called = False

    def forbidden(_server: str, _value: SignedWebhook, **_options: Any) -> dict[str, Any]:
        nonlocal second_called
        second_called = True
        return {}

    second = WebhookDeliveryManager(config(), StateStore(tmp_path), deliver=forbidden)

    def run_first() -> None:
        try:
            first.retry(receipt["receipt_id"], owner_id="u1", secret=SECRET_A)
        except BaseException as exc:
            failures.append(exc)

    worker = threading.Thread(target=run_first)
    worker.start()
    assert entered.wait(timeout=5)
    try:
        with pytest.raises(ConflictError, match="another process"):
            second.retry(receipt["receipt_id"], owner_id="u1", secret=SECRET_A)
        assert second_called is False
    finally:
        release.set()
        worker.join(timeout=5)

    assert not worker.is_alive()
    assert failures == []
    final = store.load_webhook_delivery_receipt(receipt["receipt_id"])
    assert len(final["attempts"]) == 2
    assert final["status"] == "accepted"
