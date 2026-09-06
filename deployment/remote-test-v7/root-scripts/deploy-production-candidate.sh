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
# shellcheck source=v7-transition.sh
source "${SCRIPT_DIR}/v7-transition.sh"

usage() {
  cat <<EOF
Usage:
  $0 --target v6|v7 --ticket CHANGE_ID --dry-run
  $0 --target v6|v7 --ticket CHANGE_ID --confirm 'EXACT PHRASE'

Supported exact paths: stock->v7, v5->v6, v5->v7, and v6->v7.
Every real run stops the exact source, takes and verifies its switch-snapshot
Mongo backup, and keeps it stopped while preserving the source image and
recreating only the Titra application.
EOF
}

target=''
ticket=''
dry_run=false
confirmation=''
while (( $# > 0 )); do
  case $1 in
    --target)
      (( $# >= 2 )) || die '--target requires v6 or v7.'
      target=$2
      shift 2
      ;;
    --ticket)
      (( $# >= 2 )) || die '--ticket requires a value.'
      ticket=$2
      shift 2
      ;;
    --dry-run) dry_run=true; shift ;;
    --confirm)
      (( $# >= 2 )) || die '--confirm requires a value.'
      confirmation=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown r7 deployment argument.' ;;
  esac
done
[[ $target == v6 || $target == v7 ]] || die '--target must be v6 or v7.'
validate_safe_token 'change ticket' "$ticket"
require_root
validate_production_context
validate_release_manifest
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
source_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
source_ref=$(container_value "$APP_CONTAINER" '{{.Config.Image}}')
source_kind=$(supported_source_kind "$source_id") ||
  die "Production does not run an approved stock/v5/v6 source: ${source_id}."
validate_transition "$source_kind" "$target"
target_id=$(validate_loaded_target_state "$target")
target_ref=$(target_image_ref "$target")
[[ $target_id != "$source_id" ]] || die 'Production already runs the requested target.'
if [[ $target == v7 ]]; then
  runtime_fingerprint=$(v7_runtime_fingerprint)
else
  runtime_fingerprint='not-applicable'
fi
expected_confirmation="DEPLOY TITRA ${target^^} ${target_id} FROM ${source_kind^^} ${source_id} WITH FULL PREDEPLOY DATABASE BACKUP FOR ${ticket} ON ${EXPECTED_HOST_FQDN}"

if [[ $dry_run == true ]]; then
  [[ -z $confirmation ]] || die '--confirm cannot be combined with --dry-run.'
  "${SCRIPT_DIR}/preflight-production-deploy.sh" --target "$target"
  printf 'No state was changed. A real run requires an attended maintenance acknowledgement.\n'
  printf 'If candidate creation/readiness begins and then fails, Titra is left stopped;\n'
  printf 'use the receipt-bound full rollback so application and database are restored together.\n'
  printf 'Required deployment confirmation: %s\n' "$expected_confirmation"
  exit 0
fi
[[ $confirmation == "$expected_confirmation" ]] ||
  die 'Confirmation mismatch. Run --dry-run and copy its exact phrase.'

acquire_exclusive_lock
export TITRA_OPERATOR_LOCK_FD=$LOCK_FD
validate_production_context
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
[[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$source_id" ]] ||
  die 'Production source image changed before the exclusive deployment lock was acquired.'
[[ $(validate_loaded_target_state "$target") == "$target_id" ]] ||
  die 'Deployment target changed before the exclusive lock was acquired.'
if [[ $target == v7 ]]; then
  [[ $(v7_runtime_fingerprint) == "$runtime_fingerprint" ]] ||
    die 'V7 runtime configuration changed before the exclusive lock was acquired.'
fi
"${SCRIPT_DIR}/preflight-production-deploy.sh" --target "$target"

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
random_suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
run_id="deploy-${timestamp}-${random_suffix}"
run_dir="${DEPLOYMENT_RUN_ROOT}/${run_id}"
log_dir="${DEPLOYMENT_LOG_ROOT}/${run_id}"
state_file="${run_dir}/state.env"
receipt_file="${run_dir}/receipt.env"
diagnostic_log="${log_dir}/diagnostic.log"
support_log="${log_dir}/support.log"
backup_log="${run_dir}/backup-command.log"
[[ ! -e $run_dir && ! -e $log_dir ]] || die 'Generated deployment run path already exists.'
install -d -o root -g root -m 0700 -- "$run_dir" "$log_dir"
for file in "$diagnostic_log" "$support_log" "$backup_log"; do : > "$file"; chmod 0600 -- "$file"; done

started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
completed_utc='pending'
deployment_status='IN_PROGRESS'
current_phase='initialization'
backup_id='none'
backup_archive_sha256='none'
source_state='none'
source_state_sha256='none'
runtime_config_backup='not-applicable'
mongo_identity_before='pending'
mongo_identity_after='pending'
recovery_action='not-required'
switch_started=false
app_stopped=false
deployment_succeeded=false
production_compose_sha256=$(stable_live_compose_digest)
package_release_id=$(release_value PACKAGE_RELEASE_ID)
package_checksums_sha256=$(sha256sum --binary "${INSTALL_ROOT}/SHA256SUMS" | awk '{print $1}')

write_record() {
  local destination=$1 result_key=$2 result_value=$3 phase_key temporary
  [[ $result_key == status ]] && phase_key=phase || phase_key=terminal_phase
  temporary="${destination}.tmp.$$"
  {
    printf 'format_version=1\n'
    printf 'package_release_id=%s\n' "$package_release_id"
    printf 'package_checksums_sha256=%s\n' "$package_checksums_sha256"
    printf 'run_id=%s\n' "$run_id"
    printf '%s=%s\n' "$result_key" "$result_value"
    printf '%s=%s\n' "$phase_key" "$current_phase"
    printf 'ticket=%s\n' "$ticket"
    printf 'source_kind=%s\n' "$source_kind"
    printf 'source_image_ref=%s\n' "$source_ref"
    printf 'source_image_id=%s\n' "$source_id"
    printf 'target_kind=%s\n' "$target"
    printf 'target_image_ref=%s\n' "$target_ref"
    printf 'target_image_id=%s\n' "$target_id"
    printf 'backup_id=%s\n' "$backup_id"
    printf 'backup_archive_sha256=%s\n' "$backup_archive_sha256"
    printf 'source_state=%s\n' "$source_state"
    printf 'source_state_sha256=%s\n' "$source_state_sha256"
    printf 'runtime_config_sha256=%s\n' "$runtime_fingerprint"
    printf 'runtime_config_backup=%s\n' "$runtime_config_backup"
    printf 'production_compose_sha256=%s\n' "$production_compose_sha256"
    printf 'mongo_identity_before=%s\n' "$mongo_identity_before"
    printf 'mongo_identity_after=%s\n' "$mongo_identity_after"
    printf 'recovery_action=%s\n' "$recovery_action"
    printf 'diagnostic_log=%s\n' "$diagnostic_log"
    printf 'support_log=%s\n' "$support_log"
    printf 'started_utc=%s\n' "$started_utc"
    printf 'completed_utc=%s\n' "$completed_utc"
  } > "$temporary"
  chmod 0600 -- "$temporary"
  mv -- "$temporary" "$destination"
}

support_emit() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$support_log"; }

cleanup_deployment() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ $deployment_succeeded != true ]]; then
    completed_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    deployment_status='FAILED'
    if [[ $switch_started == true ]]; then
      recovery_action='full-receipt-bound-rollback-required-app-left-stopped'
      if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
        docker stop --time 60 "$APP_CONTAINER" >/dev/null 2>&1 || true
      fi
    elif [[ $app_stopped == true &&
      $(container_value "$APP_CONTAINER" '{{.Id}}' 2>/dev/null || true) == "$expected_source_container" &&
      $(container_value "$APP_CONTAINER" '{{.Image}}' 2>/dev/null || true) == "$source_id" &&
      $(mongo_identity_snapshot 2>/dev/null || true) == "$mongo_identity_before" ]]; then
      if container_is_running "$APP_CONTAINER" && wait_for_app 180; then
        app_stopped=false
        recovery_action='exact-source-already-running-before-switch'
      elif docker start "$APP_CONTAINER" >/dev/null 2>&1 && wait_for_app 180; then
        app_stopped=false
        recovery_action='exact-source-restarted-before-switch'
      else
        recovery_action='source-restart-failed-app-left-stopped'
      fi
    elif [[ $app_stopped == true ]]; then
      if [[ $(container_value "$APP_CONTAINER" '{{.Id}}' 2>/dev/null || true) == "$expected_source_container" ]]; then
        stop_exact_app_if_running "$expected_source_container" || true
      fi
      recovery_action='source-or-mongo-identity-changed-app-left-stopped'
    else
      recovery_action='source-state-unchanged-before-switch'
    fi
    write_record "$state_file" status "$deployment_status" || true
    write_record "$receipt_file" result 'FAILED' || true
    support_emit "run=${run_id} result=FAILED phase=${current_phase} recovery=${recovery_action} backup_id=${backup_id}" || true
    printf 'Deployment failed. Sanitized support log: %s\n' "$support_log" >&3 || true
  fi
  exit "$rc"
}

exec 3>&1 4>&2
exec 5>>"$diagnostic_log"
exec 1>&5 2>&5
trap cleanup_deployment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
write_record "$state_file" status "$deployment_status"
support_emit "run=${run_id} result=IN_PROGRESS path=${source_kind}-to-${target}"

if [[ $target == v7 ]]; then
  current_phase='capture-runtime-key-backup'
  runtime_config_backup="${run_dir}/v7-runtime.env.backup"
  write_record "$state_file" status "$deployment_status"
  dd if="$V7_RUNTIME_CONFIG" of="$runtime_config_backup" \
    iflag=nofollow,nonblock,count_bytes,fullblock oflag=nofollow \
    count=$(( $(stat -c '%s' -- "$V7_RUNTIME_CONFIG") + 1 )) conv=excl,fsync status=none
  chown root:root -- "$runtime_config_backup"
  chmod 0600 -- "$runtime_config_backup"
  require_secure_regular_file "$runtime_config_backup"
  [[ $(stat -c '%u:%g:%a:%h' -- "$runtime_config_backup") == '0:0:600:1' &&
    $(sha256sum --binary "$runtime_config_backup" | awk '{print $1}') == "$runtime_fingerprint" ]] ||
    die 'Could not capture the exact v7 runtime-key configuration for receipt-bound recovery.'
fi

current_phase='maintenance-gate'
write_record "$state_file" status "$deployment_status"
maintenance_phrase="MAINTENANCE WINDOW ACTIVE AND USERS AND AUTOMATION QUIESCED FOR ${ticket}"
[[ -r /dev/tty && -w /dev/tty ]] || die 'An attended controlling terminal is required.'
printf 'Confirm the maintenance window and quiescence. Type exactly:\n%s\n> ' "$maintenance_phrase" >/dev/tty
IFS= read -r maintenance_reply </dev/tty || die 'Unable to read maintenance acknowledgement.'
[[ $maintenance_reply == "$maintenance_phrase" ]] || die 'Maintenance acknowledgement mismatch.'
unset maintenance_reply

current_phase='fresh-verified-predeploy-backup'
mongo_identity_before=$(mongo_identity_snapshot)
expected_source_container=$(container_value "$APP_CONTAINER" '{{.Id}}')
write_record "$state_file" status "$deployment_status"
"${SCRIPT_DIR}/backup-production-db.sh" --ticket "$ticket" \
  --leave-app-stopped --dry-run
# From this point until the image switch, this parent owns recovery of the
# exact source container.  Set the flag before invoking the child so a signal
# cannot fall between the child's stopped-state handoff and our cleanup trap.
app_stopped=true
"${SCRIPT_DIR}/backup-production-db.sh" --ticket "$ticket" \
  --leave-app-stopped \
  --confirm "BACK UP PRODUCTION TITRA ON ${EXPECTED_HOST_FQDN}" > "$backup_log" 2>&1
assert_exact_app_stopped "$expected_source_container"
[[ $(mongo_identity_snapshot) == "$mongo_identity_before" ]] ||
  die 'Mongo identity changed during the predeployment backup.'
mapfile -t backup_paths < <(sed -n 's/^Completed production backup: //p' "$backup_log")
[[ ${#backup_paths[@]} -eq 1 ]] || die 'Backup child did not identify exactly one completed bundle.'
mapfile -t backup_handoffs < <(grep -Fx \
  'Application handoff: exact source container remains stopped' "$backup_log" || true)
[[ ${#backup_handoffs[@]} -eq 1 ]] ||
  die 'Backup child did not prove exactly one stopped-source handoff.'
backup_path=${backup_paths[0]}
backup_id=$(basename -- "$backup_path")
[[ $(validate_recent_backup_bundle "$backup_id") == "$backup_path" ]] ||
  die 'Fresh predeployment backup failed final validation.'
[[ $(manifest_value "${backup_path}/${BACKUP_MANIFEST}" app_image_id) == "$source_id" ]] ||
  die 'Fresh predeployment backup was not made from the exact source image.'
backup_archive_sha256=$(manifest_value "${backup_path}/${BACKUP_MANIFEST}" archive_sha256)

current_phase='preserve-source-image'
write_record "$state_file" status "$deployment_status"
source_state=$(preserve_source_image "$source_kind" "$source_ref" "$source_id")
source_state_sha256=$(sha256sum --binary "$source_state" | awk '{print $1}')
support_emit "run=${run_id} backup_id=${backup_id} source_image_preserved=true"

current_phase='authoritative-stopped-gate'
write_record "$state_file" status "$deployment_status"
assert_exact_app_stopped "$expected_source_container"
wait_for_no_active_timecard_writer_leases 330
"${SCRIPT_DIR}/preflight-personal-task-suggestions.sh" --require-app-stopped
if [[ $target == v7 ]]; then
  "${SCRIPT_DIR}/preflight-v7-data-compatibility.sh" --require-app-stopped
fi
assert_exact_app_stopped "$expected_source_container"
[[ $(mongo_identity_snapshot) == "$mongo_identity_before" ]] || die 'Mongo identity changed before application switch.'

current_phase='application-switch'
write_record "$state_file" status "$deployment_status"
switch_started=true
write_transition_override "$ACTIVE_OVERRIDE" "$target_ref" "$target"
validate_transition_override "$ACTIVE_OVERRIDE" "$target" "$target_ref"
compose_prod_with_override "$ACTIVE_OVERRIDE" up --detach --no-deps --force-recreate --pull never "$APP_SERVICE"
app_stopped=false
wait_for_app 240 || die "${target^^} candidate failed readiness and will be left stopped."
[[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$target_id" ]] ||
  die 'Running application does not use the exact selected target image.'
validate_running_target_environment "$target"

current_phase='final-verification'
write_record "$state_file" status "$deployment_status"
mongo_identity_after=$(mongo_identity_snapshot)
[[ $mongo_identity_after == "$mongo_identity_before" ]] || die 'Mongo container/volume identity changed during deployment.'
[[ $(stable_live_compose_digest) == "$production_compose_sha256" ]] ||
  die 'Production Compose changed during deployment.'
[[ $(validate_recent_backup_bundle "$backup_id") == "$backup_path" ]] ||
  die 'Predeployment backup failed final revalidation.'
[[ $(sha256sum --binary "$source_state" | awk '{print $1}') == "$source_state_sha256" ]] ||
  die 'Preserved source-image state changed during deployment.'
if [[ $target == v7 ]]; then
  require_secure_regular_file "$runtime_config_backup"
  [[ $(sha256sum --binary "$runtime_config_backup" | awk '{print $1}') == "$runtime_fingerprint" ]] ||
    die 'Receipt-bound v7 runtime-key backup changed during deployment.'
fi

active_temporary="${V7_ACTIVE_STATE}.tmp.$$"
{
  printf 'format_version=1\n'
  printf 'deployment_run=%s\n' "$run_id"
  printf 'source_kind=%s\n' "$source_kind"
  printf 'source_image_id=%s\n' "$source_id"
  printf 'target_kind=%s\n' "$target"
  printf 'target_image_id=%s\n' "$target_id"
  printf 'backup_id=%s\n' "$backup_id"
  printf 'activated_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$active_temporary"
chmod 0600 -- "$active_temporary"
mv -- "$active_temporary" "$V7_ACTIVE_STATE"

current_phase='complete'
deployment_status='SUCCEEDED'
completed_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
recovery_action='not-required'
write_record "$state_file" status "$deployment_status"
write_record "$receipt_file" result 'SUCCEEDED'
support_emit "run=${run_id} result=SUCCEEDED path=${source_kind}-to-${target} backup_id=${backup_id} mongo_identity_unchanged=true"
sync -f "$run_dir"
sync -f "$log_dir"
deployment_succeeded=true
trap - EXIT INT TERM HUP
printf 'Deployment succeeded. Run ID: %s\n' "$run_id" >&3
printf 'Predeployment database backup: %s\n' "$backup_id" >&3
printf 'Sanitized support log: %s\n' "$support_log" >&3
