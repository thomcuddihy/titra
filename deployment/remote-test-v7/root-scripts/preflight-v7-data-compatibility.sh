#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
LC_ALL=C
export LC_ALL
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<EOF
Usage:
  $0 --preview
  $0 --require-app-stopped

--preview performs a read-only, non-authoritative inventory while the current
Titra application remains available.

--require-app-stopped is the authoritative v7 switch gate. It is accepted only
under an inherited exclusive operator lock and requires the exact production
Titra container to remain stopped while MongoDB stays running.

The check reads counts only, never changes MongoDB, and never prints persisted
values, document IDs, URLs, scripts, credentials, or database error text.
EOF
}

mode=''
while (( $# > 0 )); do
  case $1 in
    --preview)
      [[ -z $mode ]] || die 'Choose exactly one v7 data-compatibility preflight mode.'
      mode='preview'
      shift
      ;;
    --require-app-stopped)
      [[ -z $mode ]] || die 'Choose exactly one v7 data-compatibility preflight mode.'
      mode='stopped'
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die 'Unknown v7 data-compatibility preflight argument.'
      ;;
  esac
done
[[ -n $mode ]] || {
  usage >&2
  die 'A v7 data-compatibility preflight mode is required.'
}

require_root
acquire_shared_lock
require_secure_installation
validate_production_context
probe="${SCRIPT_DIR}/v7-data-compatibility-preflight.cjs"
require_secure_regular_file "$probe"
require_command grep
require_command mktemp

[[ $(container_value "$DB_CONTAINER" '{{.State.Running}}') == 'true' ]] ||
  die 'Production MongoDB must be running for the v7 data-compatibility preflight.'

expected_app_container=$(container_value "$APP_CONTAINER" '{{.Id}}')
if [[ $mode == 'stopped' ]]; then
  [[ $LOCK_INHERITED == true ]] ||
    die 'The stopped data-compatibility preflight requires the inherited exclusive operator lock.'
  assert_exact_app_stopped "$expected_app_container"
else
  container_is_running "$APP_CONTAINER" ||
    die 'The preview data-compatibility preflight expects the current Titra application to be running.'
fi

readonly -a count_fields=(
  probe_errors
  dashboard_all_history
  dashboard_invalid_period
  dashboard_all_projects_untrusted
  dashboard_invalid_custom_range
  dashboard_invalid_project
  project_legacy_markup_descriptions
  dashboard_slug_duplicate_groups
  dashboard_slug_key_shape_malformed
  dashboard_slug_index_conflicts
  personal_task_duplicate_groups
  personal_task_key_shape_malformed
  personal_task_index_conflicts
  verification_overdue_active
  verification_malformed_pending
  verification_malformed_flags
  verification_unrecoverable_locked
  verification_unrecoverable_pending
  verification_locked_admins
  verification_active_admins
  verification_usable_admins
  verification_enabled_without_secure_default
  security_toggle_malformed
  security_toggle_duplicate_groups
  admin_inactive_flags_malformed
  nonboolean_active_admin_flags
  admin_mutation_lock_active
  admin_mutation_lock_long
  admin_mutation_lock_malformed
  legacy_inbound_active
  legacy_outbound_active
  legacy_webhook_active
  secure_webhook_duplicate_groups
  secure_webhook_key_shape_malformed
  secure_webhook_index_conflicts
  secure_webhook_invalid_configurations
  secure_webhook_missing_secrets
  secure_webhook_candidate_over_limit
  webhook_receipt_duplicate_groups
  webhook_receipt_key_shape_malformed
  webhook_receipt_index_conflicts
  migration_backup_duplicate_groups
  migration_backup_key_shape_malformed
  migration_backup_index_conflicts
  google_oauth_duplicate_groups
  google_oauth_key_shape_malformed
  google_oauth_index_conflicts
  other_startup_index_conflicts
  stranded_project_fences
  project_membership_malformed
  resource_revisions_malformed
  timer_history_malformed
  timer_history_overflow
  active_timer_identity_malformed
  migration_lock_active
  migration_lock_malformed
  migration_runs_active
  time_rule_documents
  time_rule_unsafe
  time_rule_literal_deny
  time_rule_overflow
  plaintext_credential_fields
  credential_candidate_documents
  credential_malformed_fields
  credential_object_fields
  credential_oversized_plaintext_fields
  credential_candidate_over_limit
  plaintext_credential_over_limit
  plaintext_api_tokens
  invalid_plaintext_api_tokens
  duplicate_plaintext_api_token_groups
  duplicate_hashed_api_token_groups
  malformed_hashed_api_tokens
  api_token_key_shape_malformed
  api_token_index_conflicts
  oidc_config_documents
  oidc_invalid_enabled
  oidc_invalid_dormant
  oidc_config_overflow
  integration_candidate_documents
  integration_invalid_configurations
  integration_candidate_over_limit
  wekan_sandstorm_urls
  insecure_http_integration_urls
)
marker_pattern='^TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT status=(PASS|WARN|BLOCK|ERROR)'
for field in "${count_fields[@]}"; do
  marker_pattern+=" ${field}=[0-9]+"
done
marker_pattern+='$'

mongo_before=$(mongo_identity_snapshot)
output_file=$(mktemp --tmpdir=/run 'titra-v7-data-compatibility.XXXXXXXX')
cleanup() {
  rm -f -- "$output_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
chmod 0600 -- "$output_file"

set +e
docker exec --interactive "$DB_CONTAINER" \
  mongosh "$PROD_DATABASE" --quiet --norc --file /dev/stdin \
  < "$probe" > "$output_file" 2>&1
mongo_status=$?
set -e

assert_mongo_identity "$mongo_before" 'after the v7 data-compatibility preflight'
if [[ $mode == 'stopped' ]]; then
  assert_exact_app_stopped "$expected_app_container"
else
  [[ $(container_value "$APP_CONTAINER" '{{.Id}}') == "$expected_app_container" ]] ||
    die 'Production application container changed during the compatibility preview.'
  container_is_running "$APP_CONTAINER" ||
    die 'Production application stopped during the compatibility preview.'
fi

mapfile -t marker_lines < <(grep -E "$marker_pattern" "$output_file" || true)
[[ ${#marker_lines[@]} -eq 1 ]] ||
  die "V7 data-compatibility preflight failed without one valid sanitized result (mongosh status ${mongo_status})."

marker=${marker_lines[0]}
status=${marker#TITRA_V7_DATA_COMPATIBILITY_PREFLIGHT status=}
status=${status%% *}

marker_count() {
  local field=$1
  if [[ $marker =~ (^|[[:space:]])${field}=([0-9]+)($|[[:space:]]) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  else
    die 'Validated compatibility marker could not be parsed safely.'
  fi
}

if [[ $mode == 'stopped' ]]; then
  [[ -r /dev/tty && -w /dev/tty ]] ||
    die 'The authoritative compatibility result requires an attended controlling terminal.'
  printf '%s\n' "$marker" >/dev/tty
  if (( $(marker_count migration_lock_active) > 0 )); then
    printf 'ERROR: Migration leases remain active after quiescence; no acknowledgement can bypass this stopped-state invariant.\n' >/dev/tty
    exit 1
  fi
fi

case "${mongo_status}:${status}" in
  0:PASS)
    printf '%s\n' "$marker"
    printf 'V7 stored-data compatibility preflight passed (%s mode).\n' "$mode"
    ;;
  0:WARN)
    printf '%s\n' "$marker"
    printf 'WARNING: V7 stored-data compatibility preflight found review items (%s mode). See the operator guide for count meanings.\n' "$mode" >&2
    if [[ $mode == 'stopped' ]]; then
      require_command sha256sum
      warning_digest=$(printf '%s' "$marker" | sha256sum --binary | awk '{print $1}')
      warning_phrase="ACKNOWLEDGE V7 DATA COMPATIBILITY WARNINGS ${warning_digest}"
      printf 'Review the sanitized warning counts above. To continue, type exactly:\n%s\n> ' "$warning_phrase" >/dev/tty
      IFS= read -r warning_reply </dev/tty || die 'Unable to read compatibility-warning acknowledgement.'
      [[ $warning_reply == "$warning_phrase" ]] || die 'Compatibility-warning acknowledgement mismatch.'
      unset warning_reply warning_phrase warning_digest
    fi
    ;;
  42:BLOCK)
    printf '%s\n' "$marker" >&2
    if [[ $mode == 'stopped' ]]; then
      printf 'ERROR: V7 deployment is blocked by incompatible stored state; no MongoDB data was changed.\n' >/dev/tty
    fi
    printf 'ERROR: V7 deployment is blocked by incompatible stored state. No MongoDB data was changed; use the count names and operator guide to plan a separately reviewed repair.\n' >&2
    exit 1
    ;;
  43:ERROR)
    printf '%s\n' "$marker" >&2
    die 'V7 stored-data compatibility could not be proven; raw Mongo diagnostics were suppressed.'
    ;;
  *)
    die "V7 data-compatibility preflight returned an inconsistent sanitized result (mongosh status ${mongo_status})."
    ;;
esac
