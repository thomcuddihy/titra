"""Canonical reviewed Titra v6 and v7 capability contracts.

The command client uses this exact document before enabling hard-coded
mutations. The live deployment harness intentionally keeps a separately
reviewed copy as an independent release gate. Only the explicitly declared,
typed deployment booleans may vary at runtime.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

EXPECTED_V2_CAPABILITIES: dict[str, Any] = json.loads(
    r"""
{
  "apiVersion": 2,
  "capabilitiesVersion": 2,
  "features": {
    "identity": {"read": 1},
    "projects": {"list": 1, "create": 1, "read": 1, "detailsEdit": 1,
      "archive": 1, "emptyDelete": 1, "fenceRecovery": 1, "timeEntries": 1,
      "users": 2, "tasks": 2, "taskStats": 1},
    "timeEntries": {"create": 1, "get": 1, "delete": 1, "listByDay": 1,
      "listByRange": 1, "taskEdit": 1, "detailsEdit": 1},
    "taskSuggestions": {"list": 1, "read": 1, "delete": 1},
    "timers": {"start": 1, "get": 1, "stop": 1, "atomicTransitions": 2},
    "webhooks": {"actionVerificationReceiver": 3},
    "pagination": {"stableCursor": 1},
    "idempotency": {"create": 1}
  },
  "contracts": {
    "errors": {"version": 1, "mediaType": "application/problem+json",
      "routes": [
        {"path": "/capabilities/v2", "methods": ["GET"]},
        {"path": "/user/action-verification/webhook/:endpointId", "methods": ["POST"]}
      ],
      "otherAdvertisedRoutes": "legacy-v1-envelope"},
    "dateOnly": 1, "timecardRevisionETag": 1, "resourceRevisionETag": 1,
    "projectUserPrivacy": 1, "projectFenceRecovery": 1, "webhookHmacSha256": 1,
    "webhookRetry": {"version": 1, "authenticationTimestamp": "fresh",
      "actionTimestamp": "original", "configurationBinding": "revision",
      "retentionSeconds": 604800, "clientSafetyMarginSeconds": 600},
    "timerStartReplay": {"version": 1, "scope": "user",
      "activeReplay": "returnExisting", "consumedReplay": "conflict",
      "consumedErrorCode": "timer-operation-consumed",
      "retentionSeconds": 604800, "clientSafetyMarginSeconds": 600},
    "expectedUserId": {"version": 1, "header": "X-Titra-Expected-User-Id",
      "appliesTo": "authenticatedRequests", "required": false, "mismatchStatus": 412}
  },
  "mutationPreconditions": {
    "version": 2,
    "operations": [
      {"id": "timeEntry.create", "method": "POST", "path": "/timeentry/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"],
        "guards": ["projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.delete", "method": "DELETE",
        "path": "/timeentry/delete/:timecardId", "headers": ["If-Match"],
        "guards": ["owner", "dateRevision", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.taskEdit", "method": "PATCH",
        "path": "/timeentry/task/:timecardId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedTask"],
        "guards": ["owner", "projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "timeEntry.detailsEdit", "method": "PATCH",
        "path": "/timeentry/details/:timecardId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes", "acceptLegacyConversion when required"],
        "guards": ["owner", "projectAccess", "timeEntryRule", "migrationLease"]},
      {"id": "project.create", "method": "POST", "path": "/project/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"], "guards": ["authenticatedUser"]},
      {"id": "project.detailsEdit", "method": "PATCH",
        "path": "/project/details/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes"],
        "guards": ["projectAdministrator"]},
      {"id": "project.archive", "method": "PATCH",
        "path": "/project/archive/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedArchived"], "guards": ["projectAdministrator"]},
      {"id": "project.emptyDelete", "method": "DELETE",
        "path": "/project/delete/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName"], "guards": ["projectOwner", "emptyProject"]},
      {"id": "project.fenceRecovery", "method": "POST",
        "path": "/project/recovery/:projectId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["type", "recoveryId", "acknowledgeStaleFence=true"],
        "guards": ["projectAdministrator", "oldProcessBoot", "minimumFenceAge",
          "trackedFence", "verifiedResourceOutcome", "exactCompareAndSwap"]},
      {"id": "projectTask.create", "method": "POST", "path": "/project/task/create",
        "headers": ["Content-Type: application/json"],
        "optionalHeaders": ["Idempotency-Key"],
        "bodyPreconditions": ["start/end canonical UTC RFC3339 milliseconds"],
        "guards": ["projectAdministrator", "sameProjectDependencies"]},
      {"id": "projectTask.detailsEdit", "method": "PATCH",
        "path": "/project/task/details/:taskId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expected mirrors changes"],
        "guards": ["projectAdministrator", "sameProjectDependencies", "notDefaultWhenRenaming"]},
      {"id": "projectTask.delete", "method": "DELETE",
        "path": "/project/task/delete/:taskId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName", "acknowledgeRecordedEntries when required"],
        "guards": ["projectAdministrator", "notDefault", "noDependants"]},
      {"id": "taskSuggestion.delete", "method": "DELETE",
        "path": "/task-suggestions/delete/:suggestionId",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["expectedName", "acknowledgeReferencedRecords when required"],
        "guards": ["owner"]},
      {"id": "timer.start", "method": "POST", "path": "/timer/start",
        "headers": ["Content-Type: application/json for a nonempty body"],
        "bodyPreconditions": ["operationId for client-attributed replay"],
        "guards": ["noDifferentActiveTimer", "unconsumedOperationId"]},
      {"id": "timer.stop", "method": "POST", "path": "/timer/stop",
        "headers": ["Content-Type: application/json", "If-Match"],
        "bodyPreconditions": ["timerId"], "guards": ["exactActiveTimer"]},
      {"id": "webhook.actionVerification", "method": "POST",
        "path": "/user/action-verification/webhook/:endpointId",
        "headers": ["Content-Type: application/json", "X-Titra-Webhook-Timestamp",
          "X-Titra-Webhook-Event-Id", "X-Titra-Webhook-Signature"],
        "guards": ["enabledSecureInterface", "hmacSha256", "replayReceipt", "eventOrdering"]}
    ]
  },
  "idempotency": {"version": 1, "header": "Idempotency-Key", "minKeyLength": 16,
    "maxKeyLength": 128, "retentionSeconds": 604800,
    "operations": ["timeentry.create", "project.create", "project-task.create"]},
  "timeEntryPagination": {"version": 1, "defaultLimit": 200, "maxLimit": 500,
    "consistency": "live-keyset", "ownerPath": "timeentry/daterange-page",
    "projectPath": "project/timeentriesfordaterange-page"},
  "deployment": {"projectFenceRecoveryEnabled": false,
    "webhookActionVerificationEnabled": false},
  "limits": {"taskCodePoints": 1000, "taskEditBodyBytes": 65536,
    "webhookBodyBytes": 65536, "webhookTimestampSkewSeconds": 300,
    "webhookProcessingLeaseSeconds": 60, "webhookReplayRetentionSeconds": 604800,
    "timerStartRetainedOperations": 4096,
    "projectFenceRecoveryMinimumAgeSeconds": 900}
}
"""
)

EXPECTED_V7_CAPABILITIES = deepcopy(EXPECTED_V2_CAPABILITIES)
EXPECTED_V7_CAPABILITIES["capabilitiesVersion"] = 3
EXPECTED_V7_CAPABILITIES["features"]["security"] = {"policyDiscovery": 1}
EXPECTED_V7_CAPABILITIES["contracts"]["security"] = {
    "version": 1,
    "releaseProfile": "security-v7",
    "apiTokens": {
        "storage": "sha256-domain-separated",
        "legacyPlaintextMigration": "lazy-guarded",
        "inactiveUsersRejected": True,
    },
    "authentication": {
        "verificationDeadlineEnforced": ["httpApi", "ddpMethods", "ddpPublications"],
        "oidcIdentitySource": "userinfo",
        "oidcVerifiedEmailLinkingDefault": "disabled",
    },
    "integrations": {
        "browserCredentialPublication": "disabled",
        "outboundRequests": "server-proxied-bounded",
    },
    "publicProjects": {"operatorDisableEnforcedServerSide": True},
    "legacyJavaScript": {"default": "disabled", "literalAllowRuleExecuted": False},
    "browserHeaders": {"version": 1, "hsts": "operator-opt-in"},
}
EXPECTED_V7_CAPABILITIES["deployment"]["security"] = {
    "hstsEnabled": False,
    "oauthEncryptionConfigured": False,
    "oidcVerifiedEmailLinkingEnabled": False,
    "publicProjectsDisabled": False,
    "unsafeLegacyScriptsEnabled": False,
}


def _deployment_shape_matches(value: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(value, dict) or set(value) != set(expected):
        return False
    for name, expected_value in expected.items():
        actual = value.get(name)
        if isinstance(expected_value, bool):
            if type(actual) is not bool:
                return False
        elif isinstance(expected_value, dict):
            if (
                not isinstance(actual, dict)
                or set(actual) != set(expected_value)
                or any(type(actual.get(flag)) is not bool for flag in expected_value)
            ):
                return False
        elif actual != expected_value:
            return False
    return True


def _exact_capabilities(value: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(value, dict):
        return False
    deployment = value.get("deployment")
    expected_deployment = expected["deployment"]
    if not _deployment_shape_matches(deployment, expected_deployment):
        return False
    return {**value, "deployment": expected_deployment} == expected


def exact_v2_capabilities(value: Any) -> bool:
    """Accept only the exact reviewed v6 or v7 contract and typed deployment flags."""

    return _exact_capabilities(value, EXPECTED_V2_CAPABILITIES) or _exact_capabilities(
        value, EXPECTED_V7_CAPABILITIES
    )


def exact_v7_capabilities(value: Any) -> bool:
    """Return whether *value* is the exact v7 security contract."""

    return _exact_capabilities(value, EXPECTED_V7_CAPABILITIES)
