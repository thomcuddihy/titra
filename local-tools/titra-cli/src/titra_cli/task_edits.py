"""Guarded task-only editing with durable, credential-free audit receipts."""

from __future__ import annotations

import json
from contextlib import suppress
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

from .api import MAX_SAFE_REVISION, TitraClient, revision_from_etag, validate_task_edit
from .errors import (
    AuthenticationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    OutcomeUnknownError,
    WriteRejectedError,
)
from .models import ResolvedConfig, utc_now_iso
from .services import record_preview
from .state import StateStore
from .timer import assert_expected_identity


@dataclass(frozen=True)
class TaskEditPlan:
    record_id: str
    owner_id: str
    before: dict[str, Any]
    before_etag: str
    task: str
    preview: dict[str, Any]


def _assert_snapshot(
    record: dict[str, Any], etag: str | None, record_id: str, owner_id: str
) -> str:
    if record.get("_id") != record_id or not owner_id or record.get("userId") != owner_id:
        raise AuthenticationError("Task editing requires a record owned by the authenticated user.")
    if not isinstance(record.get("task"), str):
        raise ConfigurationError("Record has no string Task value; refusing an unsafe edit.")
    revision = record.get("dateRevision")
    valid_revision = "dateRevision" not in record or (type(revision) is int and revision >= 0)
    if not valid_revision or revision != revision_from_etag(etag):
        raise ConfigurationError("Record revision does not match its ETag; refusing task edit.")
    assert etag is not None
    return etag


def prepare_task_edit(
    config: ResolvedConfig,
    client: TitraClient,
    record_id: str,
    task: str,
    *,
    expected_task: str | None = None,
    if_match: str | None = None,
) -> TaskEditPlan:
    if not record_id or len(record_id) > 128:
        raise ConfigurationError("Record ID must contain 1 to 128 characters.")
    validate_task_edit(task, expected_task if expected_task is not None else "")
    if if_match is not None:
        revision_from_etag(if_match)
    user = assert_expected_identity(client, config)
    if not client.supports_task_edit():
        raise ConfigurationError(
            "Server does not advertise guarded task editing. Deploy a compatible API first; "
            "no PATCH was sent."
        )
    owner_id = user.get("_id")
    if not isinstance(owner_id, str) or not owner_id:
        raise AuthenticationError("Server returned no authenticated user ID.")
    before, etag = client.get_time_entry_snapshot(record_id)
    etag = _assert_snapshot(before, etag, record_id, owner_id)
    validate_task_edit(task, before["task"])
    if task != before["task"] and before.get("dateRevision") == MAX_SAFE_REVISION:
        raise ConfigurationError("Task edit cannot safely increment the maximum revision.")
    if config.api_key in task or config.api_key in json.dumps(before, ensure_ascii=False):
        raise ConfigurationError("Refusing to persist task data containing the configured API key.")
    if expected_task is not None and before["task"] != expected_task:
        raise ConflictError("Task differs from --expect-task; nothing was changed.")
    if if_match is not None and etag != if_match:
        raise ConflictError("Revision differs from --if-match; nothing was changed.")
    projects = {str(item.get("_id")): item for item in client.list_projects()}
    preview = {
        **record_preview(before, config=config, projects=projects),
        "previousTask": before["task"],
        "task": task,
        "changed": task != before["task"],
        "etag": etag,
        # Never normalize/round the hours that the operator is approving.
        "hours": before.get("hours"),
    }
    if config.api_key in json.dumps(preview, ensure_ascii=False):
        raise ConfigurationError("Refusing a preview containing the configured API key.")
    return TaskEditPlan(record_id, owner_id, deepcopy(before), etag, task, preview)


def _expected_after(before: dict[str, Any], task: str) -> dict[str, Any]:
    expected = deepcopy(before)
    if before["task"] != task:
        expected["task"] = task
        expected["dateRevision"] = before.get("dateRevision", 0) + 1
    return expected


def _matches_after(
    before: dict[str, Any], task: str, after: dict[str, Any], after_etag: str | None
) -> bool:
    expected = _expected_after(before, task)
    return _same_snapshot(after, expected) and after_etag == _snapshot_etag(expected)


def _snapshot_etag(record: dict[str, Any]) -> str:
    return f'"titra-date-revision-{record.get("dateRevision", "legacy")}"'


def _same_snapshot(left: dict[str, Any], right: dict[str, Any]) -> bool:
    # Python equality considers True == 1; raw JSON records must preserve their types too.
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(
        right, sort_keys=True, ensure_ascii=False
    )


def apply_task_edit(
    config: ResolvedConfig, client: TitraClient, store: StateStore, plan: TaskEditPlan
) -> dict[str, Any]:
    """Issue at most one PATCH. Any post-submit failure requires read-only reconciliation."""
    store.add_secret(config.api_key)
    receipt: dict[str, Any] = {
        "schema": "titra-cli/task-edit-receipt/v1",
        "receipt_id": uuid4().hex,
        "created_at": utc_now_iso(),
        "profile": config.profile,
        "server": config.server,
        "owner_id": plan.owner_id,
        "record_id": plan.record_id,
        "status": "pending",
        "before": deepcopy(plan.before),
        "before_etag": plan.before_etag,
        "proposed_payload": {"task": plan.task, "expectedTask": plan.before["task"]},
        "retry_safe": False,
    }
    receipt_path = store.task_edit_receipt_path(receipt["receipt_id"])
    try:
        store.save_task_edit_receipt(receipt)
        receipt["status"] = "submitting"
        receipt["submitted_at"] = utc_now_iso()
        store.save_task_edit_receipt(receipt)
    except OSError as exc:
        raise ConfigurationError(
            f"Cannot persist task-edit receipt; no PATCH sent. Receipt: {receipt_path}"
        ) from exc
    try:
        result, response_etag = client.edit_time_entry_task(
            plan.record_id,
            task=plan.task,
            expected_task=plan.before["task"],
            etag=plan.before_etag,
        )
    except (AuthenticationError, NotFoundError, WriteRejectedError) as exc:
        receipt["status"] = "rejected"
        receipt["error_type"] = type(exc).__name__
        _best_effort_save(store, receipt)
        # Do not echo remote error strings: an upstream service could reflect credentials.
        raise type(exc)(f"Task edit rejected; no retry attempted. Receipt: {receipt_path}") from exc
    except BaseException as exc:
        _unknown(store, receipt, receipt_path, exc)
    try:
        receipt["write_result"] = result
        receipt["response_etag"] = response_etag
        receipt["status"] = "verifying"
        store.save_task_edit_receipt(receipt)
        after, after_etag = client.get_time_entry_snapshot(plan.record_id)
        if not _matches_after(plan.before, plan.task, after, after_etag):
            receipt["verification_issue"] = "Readback did not match the exact task-only change."
            raise ConflictError("Readback differs from the exact task-only change.")
        receipt["after"] = after
        receipt["after_etag"] = after_etag
        receipt["status"] = "verified" if result["changed"] else "verified_noop"
        receipt["verified_at"] = utc_now_iso()
        store.save_task_edit_receipt(receipt)
    except BaseException as exc:
        _unknown(store, receipt, receipt_path, exc)
    return {
        **plan.preview,
        "timecardId": plan.record_id,
        "etag": after_etag,
        "status": receipt["status"],
        "receipt_id": receipt["receipt_id"],
        "receipt": str(receipt_path),
    }


def _best_effort_save(store: StateStore, receipt: dict[str, Any]) -> None:
    # The durable submitting/verifying receipt still prohibits a blind retry.
    with suppress(OSError, ConfigurationError, ConflictError):
        store.save_task_edit_receipt(receipt)


def _unknown(
    store: StateStore, receipt: dict[str, Any], path: Path, cause: BaseException
) -> NoReturn:
    receipt["status"] = "outcome_unknown"
    receipt["error_type"] = type(cause).__name__
    _best_effort_save(store, receipt)
    raise OutcomeUnknownError(
        "Task-edit outcome is uncertain. Do not retry or delete/recreate the record. "
        f"Use record reconcile-task-edit {receipt['receipt_id']}. Receipt: {path}"
    ) from cause


def reconcile_task_edit(
    config: ResolvedConfig, client: TitraClient, store: StateStore, receipt_id: str
) -> dict[str, Any]:
    """GET-only diagnosis. Never resubmit and never change the original audit receipt."""
    receipt = store.load_task_edit_receipt(receipt_id)
    if (
        receipt.get("schema") != "titra-cli/task-edit-receipt/v1"
        or receipt.get("receipt_id") != receipt_id
        or receipt.get("profile") != config.profile
        or receipt.get("server") != config.server
    ):
        raise ConfigurationError("Receipt does not match this profile/server or schema.")
    before, payload = receipt.get("before"), receipt.get("proposed_payload")
    if not isinstance(before, dict) or not isinstance(payload, dict):
        raise ConfigurationError("Receipt has malformed snapshots or payload.")
    record_id, owner_id = receipt.get("record_id"), receipt.get("owner_id")
    if not isinstance(record_id, str) or not isinstance(owner_id, str):
        raise ConfigurationError("Receipt has invalid record/owner IDs.")
    task, expected_task = payload.get("task"), payload.get("expectedTask")
    if not isinstance(task, str) or not isinstance(expected_task, str):
        raise ConfigurationError("Receipt Task values must be strings.")
    validate_task_edit(task, expected_task)
    _assert_snapshot(before, receipt.get("before_etag"), record_id, owner_id)
    if before["task"] != expected_task:
        raise ConfigurationError("Receipt expected task does not match its saved snapshot.")
    user = assert_expected_identity(client, config)
    if user.get("_id") != owner_id:
        raise AuthenticationError("Receipt belongs to a different authenticated user.")
    try:
        observed, etag = client.get_time_entry_snapshot(record_id)
    except NotFoundError:
        status = "record_unavailable"
        after, etag = None, None
    else:
        _assert_snapshot(observed, etag, record_id, owner_id)
        after = observed
        if _matches_after(before, task, observed, etag):
            status = "matches_proposed_change" if task != expected_task else "matches_noop"
        elif _same_snapshot(observed, before) and etag == receipt.get("before_etag"):
            status = "matches_before_snapshot"
        else:
            status = "diverged"
    return {
        "timecardId": record_id,
        "status": status,
        "receipt_id": receipt_id,
        "receipt": str(store.task_edit_receipt_path(receipt_id)),
        "read_only": True,
        "retry_safe": False,
        "after": _redact_secret(after, config.api_key),
        "etag": etag,
        "note": "Observation only, not proof of who changed the record. No retry was performed.",
    }


def _redact_secret(value: Any, secret: str) -> Any:
    if isinstance(value, dict):
        return {
            str(key).replace(secret, "<redacted>"): _redact_secret(item, secret)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_secret(item, secret) for item in value]
    if isinstance(value, str):
        return value.replace(secret, "<redacted>")
    return value
