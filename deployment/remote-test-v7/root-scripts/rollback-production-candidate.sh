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
  $0 --ticket CHANGE_ID --deployment-run deploy-... --dry-run
  $0 --ticket CHANGE_ID --deployment-run deploy-... --confirm 'EXACT PHRASE'

This is intentionally a full rollback. It restores the exact predeployment
database backup and exact preserved source image from a selected successful r7
deployment receipt or a receipt-bound failed post-switch attempt. There is no
application-only rollback mode because v7 may have sealed credentials that
older releases cannot read.
EOF
}

validate_deployment_receipt() {
  local run=$1 directory receipt keys expected_keys result terminal_phase recovery
  [[ $run =~ ^deploy-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || die 'Invalid deployment run ID.'
  directory="${DEPLOYMENT_RUN_ROOT}/${run}"
  receipt="${directory}/receipt.env"
  require_secure_directory "$directory"
  require_secure_regular_file "$receipt"
  keys=$(awk -F= '{print $1}' "$receipt" | paste -sd ',' -)
  expected_keys='format_version,package_release_id,package_checksums_sha256,run_id,result,terminal_phase,ticket,source_kind,source_image_ref,source_image_id,target_kind,target_image_ref,target_image_id,backup_id,backup_archive_sha256,source_state,source_state_sha256,runtime_config_sha256,runtime_config_backup,production_compose_sha256,mongo_identity_before,mongo_identity_after,recovery_action,diagnostic_log,support_log,started_utc,completed_utc'
  [[ $keys == "$expected_keys" ]] || die 'Deployment receipt has an unexpected schema.'
  [[ $(manifest_value "$receipt" format_version) == '1' &&
    $(manifest_value "$receipt" package_release_id) == "$(release_value PACKAGE_RELEASE_ID)" &&
    $(manifest_value "$receipt" package_checksums_sha256) == "$(sha256sum --binary "${INSTALL_ROOT}/SHA256SUMS" | awk '{print $1}')" &&
    $(manifest_value "$receipt" run_id) == "$run" ]] ||
    die 'Deployment receipt does not belong to this exact package and run.'
  result=$(manifest_value "$receipt" result)
  terminal_phase=$(manifest_value "$receipt" terminal_phase)
  recovery=$(manifest_value "$receipt" recovery_action)
  if [[ $result == 'SUCCEEDED' ]]; then
    [[ $terminal_phase == 'complete' && $recovery == 'not-required' ]] ||
      die 'Successful deployment receipt has inconsistent terminal state.'
  elif [[ $result == 'FAILED' ]]; then
    [[ $terminal_phase == 'application-switch' || $terminal_phase == 'final-verification' ||
      $terminal_phase == 'complete' ]] ||
      die 'Failed deployment receipt did not reach a receipt-bound post-switch phase.'
    [[ $recovery == 'full-receipt-bound-rollback-required-app-left-stopped' ]] ||
      die 'Failed deployment receipt does not authorize the full recovery path.'
  else
    die 'Deployment receipt is neither a successful deployment nor an approved failed post-switch recovery receipt.'
  fi
  printf '%s\n' "$receipt"
}

ticket=''
deployment_run=''
dry_run=false
confirmation=''
while (( $# > 0 )); do
  case $1 in
    --ticket)
      (( $# >= 2 )) || die '--ticket requires a value.'
      ticket=$2
      shift 2
      ;;
    --deployment-run)
      (( $# >= 2 )) || die '--deployment-run requires a value.'
      deployment_run=$2
      shift 2
      ;;
    --dry-run) dry_run=true; shift ;;
    --confirm)
      (( $# >= 2 )) || die '--confirm requires a value.'
      confirmation=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown r7 rollback argument.' ;;
  esac
done
validate_safe_token 'change ticket' "$ticket"
require_root
validate_production_recovery_context
validate_release_manifest
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
deployment_receipt=$(validate_deployment_receipt "$deployment_run")
source_kind=$(manifest_value "$deployment_receipt" source_kind)
source_ref=$(manifest_value "$deployment_receipt" source_image_ref)
source_id=$(manifest_value "$deployment_receipt" source_image_id)
target_kind=$(manifest_value "$deployment_receipt" target_kind)
target_ref=$(manifest_value "$deployment_receipt" target_image_ref)
target_id=$(manifest_value "$deployment_receipt" target_image_id)
backup_id=$(manifest_value "$deployment_receipt" backup_id)
source_state=$(manifest_value "$deployment_receipt" source_state)
source_state_sha256=$(manifest_value "$deployment_receipt" source_state_sha256)
deployment_runtime_fingerprint=$(manifest_value "$deployment_receipt" runtime_config_sha256)
deployment_runtime_backup=$(manifest_value "$deployment_receipt" runtime_config_backup)
deployment_result=$(manifest_value "$deployment_receipt" result)
application_container_present=false
current_application_id='absent'
current_application_running='false'
if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  application_container_present=true
  current_application_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  current_application_running=$(container_value "$APP_CONTAINER" '{{.State.Running}}')
fi
if [[ $deployment_result == 'SUCCEEDED' ]]; then
  if [[ $application_container_present == true && $current_application_id == "$target_id" ]]; then
    :
  elif [[ $application_container_present != true ||
    ( $current_application_id == "$source_id" && $current_application_running == 'false' ) ]]; then
    :
  else
    die 'Application is neither the receipt target nor an absent/stopped exact source recovery state.'
  fi
else
  [[ $current_application_running == 'false' ]] ||
    die 'A failed post-switch recovery receipt requires the application to remain stopped.'
  [[ $application_container_present != true || $current_application_id == "$target_id" ||
    $current_application_id == "$source_id" ]] ||
    die 'Stopped application is absent or must be the receipt source/target image.'
fi
target_image_id_is_allowed "$target_kind" "$target_id" || die 'Receipt target is outside its release allowlist.'
[[ $target_ref == "$(target_image_ref "$target_kind")" ]] || die 'Receipt target reference differs from the release manifest.'
[[ $(supported_source_kind "$source_id") == "$source_kind" ]] || die 'Receipt source identity is inconsistent.'
validate_transition "$source_kind" "$target_kind"
[[ $(validate_preserved_source "$source_kind" "$source_id") == "$source_state" &&
  $(sha256sum --binary "$source_state" | awk '{print $1}') == "$source_state_sha256" &&
  $(manifest_value "$source_state" source_image_ref) == "$source_ref" ]] ||
  die 'Receipt-bound preserved source-image state failed validation.'
[[ $(manifest_value "$deployment_receipt" production_compose_sha256) == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
  die 'Receipt was not created under this exact production Compose definition.'
if [[ $target_kind == v7 ]]; then
  expected_runtime_backup="${DEPLOYMENT_RUN_ROOT}/${deployment_run}/v7-runtime.env.backup"
  [[ $deployment_runtime_backup == "$expected_runtime_backup" ]] ||
    die 'Receipt-bound v7 runtime-key backup path is not canonical.'
  require_secure_regular_file "$deployment_runtime_backup"
  [[ $(stat -c '%u:%g:%a:%h' -- "$deployment_runtime_backup") == '0:0:600:1' &&
    $(sha256sum --binary "$deployment_runtime_backup" | awk '{print $1}') == "$deployment_runtime_fingerprint" ]] ||
    die 'Receipt-bound v7 runtime-key backup failed identity validation.'
  [[ $(v7_runtime_fingerprint) == "$deployment_runtime_fingerprint" ]] ||
    die 'The persistent OAuth key/runtime configuration differs from the deployment receipt.'
else
  [[ $deployment_runtime_fingerprint == 'not-applicable' &&
    $deployment_runtime_backup == 'not-applicable' ]] ||
    die 'Non-v7 deployment receipt unexpectedly binds a v7 runtime configuration.'
fi
target_bundle=$(validate_backup_bundle "$backup_id" "$BACKUP_ROOT")
[[ $(manifest_value "${target_bundle}/${BACKUP_MANIFEST}" archive_sha256) == \
  "$(manifest_value "$deployment_receipt" backup_archive_sha256)" ]] ||
  die 'Receipt-bound predeployment database backup digest changed.'
[[ $(manifest_value "${target_bundle}/${BACKUP_MANIFEST}" app_image_id) == "$source_id" ]] ||
  die 'Receipt-bound database backup was not made under the exact source image.'
require_backup_capacity "$BACKUP_ROOT"
require_production_restore_capacity "$target_bundle"
expected_confirmation="FULL ROLLBACK TITRA ${target_kind^^} ${target_id} TO ${source_kind^^} ${source_id} AND RESTORE DATABASE ${backup_id} FOR ${ticket} ON ${EXPECTED_HOST_FQDN}"

if [[ $dry_run == true ]]; then
  [[ -z $confirmation ]] || die '--confirm cannot be combined with --dry-run.'
  printf 'Full rollback preview passed. A real run first takes another verified safety backup,\n'
  printf 'then restores both the exact source image and the exact predeployment database.\n'
  printf 'Application-only rollback is forbidden after v7 credential encryption.\n'
  printf '  deployment: %s (%s receipt)\n' "$deployment_run" "$deployment_result"
  printf '  application: %s -> %s\n' "$target_kind" "$source_kind"
  printf '  database restore: %s\n' "$backup_id"
  printf 'Required rollback confirmation: %s\n' "$expected_confirmation"
  exit 0
fi
[[ $confirmation == "$expected_confirmation" ]] ||
  die 'Confirmation mismatch. Run --dry-run and copy its exact phrase.'

acquire_exclusive_lock
export TITRA_OPERATOR_LOCK_FD=$LOCK_FD
validate_production_recovery_context
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
deployment_receipt=$(validate_deployment_receipt "$deployment_run")
[[ $(manifest_value "$deployment_receipt" result) == "$deployment_result" ]] ||
  die 'Deployment receipt result changed before the exclusive rollback lock was acquired.'
locked_application_present=false
locked_application_id='absent'
locked_application_running='false'
if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  locked_application_present=true
  locked_application_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  locked_application_running=$(container_value "$APP_CONTAINER" '{{.State.Running}}')
fi
if [[ $deployment_result == 'SUCCEEDED' ]]; then
  if [[ $locked_application_present == true && $locked_application_id == "$target_id" ]]; then
    :
  elif [[ $locked_application_present != true ||
    ( $locked_application_id == "$source_id" && $locked_application_running == 'false' ) ]]; then
    :
  else
    die 'Production target/recovery state changed before the exclusive rollback lock was acquired.'
  fi
else
  [[ $locked_application_running == 'false' &&
    ( $locked_application_present != true || $locked_application_id == "$target_id" ||
      $locked_application_id == "$source_id" ) ]] ||
    die 'Failed-switch recovery state changed before the exclusive rollback lock was acquired.'
fi
target_bundle=$(validate_backup_bundle "$backup_id" "$BACKUP_ROOT")

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
random_suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
run_id="rollback-${timestamp}-${random_suffix}"
run_dir="${ROLLBACK_RUN_ROOT}/${run_id}"
log_dir="${DEPLOYMENT_LOG_ROOT}/${run_id}"
state_file="${run_dir}/state.env"
receipt_file="${run_dir}/receipt.env"
diagnostic_log="${log_dir}/diagnostic.log"
support_log="${log_dir}/support.log"
safety_backup_log="${run_dir}/safety-backup-command.log"
[[ ! -e $run_dir && ! -e $log_dir ]] || die 'Generated rollback run path already exists.'
install -d -o root -g root -m 0700 -- "$run_dir" "$log_dir"
for file in "$diagnostic_log" "$support_log" "$safety_backup_log"; do : > "$file"; chmod 0600 -- "$file"; done

started_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
completed_utc='pending'
rollback_status='IN_PROGRESS'
current_phase='initialization'
safety_backup_id='none'
mongo_identity_before='pending'
mongo_identity_after='pending'
recovery_action='not-required'
destructive_restore_started=false
target_replacement_started=false
app_stopped=false
restart_target_on_prerestore_failure=false
pre_restore_target_container_id=''
rollback_succeeded=false
expected_summary=''
actual_summary=''
TARGET_ARCHIVE_FD=''
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
    printf 'deployment_run=%s\n' "$deployment_run"
    printf 'source_kind=%s\n' "$source_kind"
    printf 'source_image_id=%s\n' "$source_id"
    printf 'target_kind=%s\n' "$target_kind"
    printf 'target_image_id=%s\n' "$target_id"
    printf 'restored_backup_id=%s\n' "$backup_id"
    printf 'safety_backup_id=%s\n' "$safety_backup_id"
    printf 'retained_runtime_config_sha256=%s\n' "$deployment_runtime_fingerprint"
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
cleanup_rollback() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ $rollback_succeeded != true ]]; then
    completed_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    rollback_status='FAILED'
    if [[ $destructive_restore_started == true || $target_replacement_started == true ]]; then
      recovery_action='manual-reviewed-recovery-required-app-left-stopped'
      docker stop --time 60 "$APP_CONTAINER" >/dev/null 2>&1 || true
    elif [[ $app_stopped == true && $restart_target_on_prerestore_failure == true &&
      $(container_value "$APP_CONTAINER" '{{.Id}}' 2>/dev/null || true) == "$pre_restore_target_container_id" &&
      $(container_value "$APP_CONTAINER" '{{.Image}}' 2>/dev/null || true) == "$target_id" &&
      $(mongo_identity_snapshot 2>/dev/null || true) == "$mongo_identity_before" ]]; then
      if container_is_running "$APP_CONTAINER" && wait_for_app 180; then
        app_stopped=false
        recovery_action='exact-target-already-running-before-restore'
      elif start_existing_app_container "$pre_restore_target_container_id"; then
        app_stopped=false
        recovery_action='exact-target-restarted-before-restore'
      else
        recovery_action='target-restart-failed-app-left-stopped'
      fi
    elif [[ $app_stopped == true ]]; then
      recovery_action='initial-stopped-state-retained'
    else
      recovery_action='target-state-unchanged'
    fi
    write_record "$state_file" status "$rollback_status" || true
    write_record "$receipt_file" result 'FAILED' || true
    support_emit "run=${run_id} result=FAILED phase=${current_phase} recovery=${recovery_action} safety_backup_id=${safety_backup_id}" || true
    printf 'Rollback failed. Sanitized support log: %s\n' "$support_log" >&3 || true
  fi
  [[ -z $expected_summary || ! -f $expected_summary ]] || rm -f -- "$expected_summary"
  [[ -z $actual_summary || ! -f $actual_summary ]] || rm -f -- "$actual_summary"
  if [[ -n $TARGET_ARCHIVE_FD ]]; then exec {TARGET_ARCHIVE_FD}<&- || true; fi
  exit "$rc"
}

exec 3>&1 4>&2
exec 5>>"$diagnostic_log"
exec 1>&5 2>&5
trap cleanup_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
write_record "$state_file" status "$rollback_status"
support_emit "run=${run_id} result=IN_PROGRESS full_rollback=${target_kind}-to-${source_kind} restore_backup_id=${backup_id}"

current_phase='maintenance-gate'
write_record "$state_file" status "$rollback_status"
maintenance_phrase="FULL ROLLBACK WINDOW ACTIVE AND USERS AND AUTOMATION QUIESCED FOR ${ticket}"
[[ -r /dev/tty && -w /dev/tty ]] || die 'An attended controlling terminal is required.'
printf 'This rollback restores the entire database. Type exactly:\n%s\n> ' "$maintenance_phrase" >/dev/tty
IFS= read -r maintenance_reply </dev/tty || die 'Unable to read rollback maintenance acknowledgement.'
[[ $maintenance_reply == "$maintenance_phrase" ]] || die 'Rollback maintenance acknowledgement mismatch.'
unset maintenance_reply

current_phase='fresh-current-state-safety-backup'
mongo_identity_before=$(mongo_identity_snapshot)
write_record "$state_file" status "$rollback_status"
if [[ $locked_application_present != true ]]; then
  source_rollback_ref=$(ensure_preserved_source_loaded "$source_kind" "$source_id")
  if [[ $source_kind == v6 ]]; then source_override_kind=v6; else source_override_kind=source; fi
  write_transition_override "$ACTIVE_OVERRIDE" "$source_rollback_ref" "$source_override_kind"
  validate_transition_override "$ACTIVE_OVERRIDE" "$source_override_kind" "$source_rollback_ref"
  app_stopped=true
  compose_prod_with_override "$ACTIVE_OVERRIDE" up --no-start --no-deps --force-recreate --pull never "$APP_SERVICE"
  [[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$source_id" &&
    $(container_value "$APP_CONTAINER" '{{.State.Running}}') == 'false' ]] ||
    die 'Could not recreate the exact stopped source application for the safety backup.'
  locked_application_present=true
  locked_application_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  locked_application_running='false'
fi
if [[ $(container_value "$APP_CONTAINER" '{{.State.Running}}') == 'true' ]]; then
  pre_restore_target_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  restart_target_on_prerestore_failure=true
  "${SCRIPT_DIR}/backup-production-db.sh" --ticket "$ticket" \
    --leave-app-stopped --dry-run
  # This parent owns the target restart before the child transfers its stopped
  # state, closing the signal window at the successful handoff boundary.
  app_stopped=true
  "${SCRIPT_DIR}/backup-production-db.sh" --ticket "$ticket" \
    --leave-app-stopped \
    --confirm "BACK UP PRODUCTION TITRA ON ${EXPECTED_HOST_FQDN}" > "$safety_backup_log" 2>&1
  assert_exact_app_stopped "$pre_restore_target_container_id"
  [[ $(mongo_identity_snapshot) == "$mongo_identity_before" ]] ||
    die 'Mongo identity changed during the current-state safety backup.'
  mapfile -t safety_paths < <(sed -n 's/^Completed production backup: //p' "$safety_backup_log")
  [[ ${#safety_paths[@]} -eq 1 ]] || die 'Safety backup child did not identify exactly one completed bundle.'
  mapfile -t safety_handoffs < <(grep -Fx \
    'Application handoff: exact source container remains stopped' "$safety_backup_log" || true)
  [[ ${#safety_handoffs[@]} -eq 1 ]] ||
    die 'Safety backup child did not prove exactly one stopped-target handoff.'
  safety_path=${safety_paths[0]}
else
  safety_path=$(create_database_backup_bundle "$BACKUP_ROOT" 'prod' \
    'stopped-application-pre-rollback-safety-backup' "$ticket")
  printf 'Completed stopped-state production safety backup: %s\n' "$safety_path" > "$safety_backup_log"
fi
safety_backup_id=$(basename -- "$safety_path")
validate_recent_backup_bundle "$safety_backup_id" >/dev/null
if [[ $target_kind == v7 ]]; then
  [[ $(v7_runtime_fingerprint) == "$deployment_runtime_fingerprint" ]] ||
    die 'OAuth key/runtime configuration changed during full rollback.'
fi

current_phase='pin-and-dry-run-original-backup'
write_record "$state_file" status "$rollback_status"
target_bundle=$(validate_backup_bundle "$backup_id" "$BACKUP_ROOT")
target_archive="${target_bundle}/${BACKUP_ARCHIVE}"
target_digest=$(manifest_value "${target_bundle}/${BACKUP_MANIFEST}" archive_sha256)
exec {TARGET_ARCHIVE_FD}<"$target_archive"
pinned_archive="/proc/$$/fd/${TARGET_ARCHIVE_FD}"
[[ $(sha256sum --binary "$pinned_archive" | awk '{print $1}') == "$target_digest" ]] ||
  die 'Pinned predeployment archive failed its final checksum.'
expected_summary=$(mktemp --tmpdir=/run 'titra-r7-expected-summary.XXXXXXXX.json')
actual_summary=$(mktemp --tmpdir=/run 'titra-r7-actual-summary.XXXXXXXX.json')
cp -- "${target_bundle}/database-summary.json" "$expected_summary"
chmod 0600 -- "$expected_summary" "$actual_summary"
configure_mongo_heavy_priority
docker exec -i "$DB_CONTAINER" "${MONGO_HEAVY_PREFIX[@]}" mongorestore \
  --dryRun --archive --gzip --nsInclude='titra.*' < "$pinned_archive" >/dev/null
require_production_restore_capacity "$target_bundle"

current_phase='stop-target-and-recreate-source-stopped'
write_record "$state_file" status "$rollback_status"
target_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
if container_is_running "$APP_CONTAINER"; then
  docker stop --time 60 "$APP_CONTAINER" >/dev/null
fi
app_stopped=true
assert_exact_app_stopped "$target_container_id"
wait_for_no_active_timecard_writer_leases 330
if [[ $target_kind == v7 ]]; then
  runtime_restore_temporary="${V7_RUNTIME_CONFIG}.rollback.${run_id}"
  [[ ! -e $runtime_restore_temporary && ! -L $runtime_restore_temporary ]] ||
    die 'Runtime-key restore temporary path already exists.'
  dd if="$deployment_runtime_backup" of="$runtime_restore_temporary" \
    iflag=nofollow,nonblock,count_bytes,fullblock oflag=nofollow \
    count=$(( $(stat -c '%s' -- "$deployment_runtime_backup") + 1 )) conv=excl,fsync status=none
  chown root:root -- "$runtime_restore_temporary"
  chmod 0600 -- "$runtime_restore_temporary"
  [[ $(sha256sum --binary "$runtime_restore_temporary" | awk '{print $1}') == "$deployment_runtime_fingerprint" ]] ||
    die 'Restored runtime-key configuration differs from the deployment receipt.'
  mv -- "$runtime_restore_temporary" "$V7_RUNTIME_CONFIG"
  [[ $(v7_runtime_fingerprint) == "$deployment_runtime_fingerprint" ]] ||
    die 'Persistent OAuth key/runtime configuration restore failed.'
  sync -f "$V7_RUNTIME_CONFIG"
  sync -f "$STATE_ROOT"
fi
source_rollback_ref=$(ensure_preserved_source_loaded "$source_kind" "$source_id")
if [[ $source_kind == v6 ]]; then source_override_kind=v6; else source_override_kind=source; fi
target_replacement_started=true
write_transition_override "$ACTIVE_OVERRIDE" "$source_rollback_ref" "$source_override_kind"
validate_transition_override "$ACTIVE_OVERRIDE" "$source_override_kind" "$source_rollback_ref"
compose_prod_with_override "$ACTIVE_OVERRIDE" up --no-start --no-deps --force-recreate --pull never "$APP_SERVICE"
source_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
[[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$source_id" &&
  $(container_value "$APP_CONTAINER" '{{.State.Running}}') == 'false' ]] ||
  die 'Exact source application container was not recreated in stopped state.'

current_phase='destructive-database-restore'
write_record "$state_file" status "$rollback_status"
destructive_restore_started=true
drop_production_database
restore_archive_to_production "$pinned_archive"
exec {TARGET_ARCHIVE_FD}<&-
TARGET_ARCHIVE_FD=''
write_database_summary "$actual_summary"
[[ $(sha256sum --binary "$actual_summary" | awk '{print $1}') == \
  "$(manifest_value "${target_bundle}/${BACKUP_MANIFEST}" database_summary_sha256)" ]] ||
  die 'Restored database summary digest differs from the predeployment backup.'
cmp --silent "$actual_summary" "$expected_summary" ||
  die 'Restored database summary is not byte-for-byte identical to the predeployment backup.'
[[ $(mongo_identity_snapshot) == "$mongo_identity_before" ]] || die 'Mongo identity changed during database restore.'

current_phase='start-and-verify-source'
write_record "$state_file" status "$rollback_status"
docker start "$APP_CONTAINER" >/dev/null
wait_for_app 240 || die 'Restored source application failed readiness and was left stopped.'
app_stopped=false
[[ $(container_value "$APP_CONTAINER" '{{.Id}}') == "$source_container_id" &&
  $(container_value "$APP_CONTAINER" '{{.Image}}') == "$source_id" ]] ||
  die 'Rollback did not start the exact recreated source application.'
validate_running_target_environment "$source_override_kind"
mongo_identity_after=$(mongo_identity_snapshot)
[[ $mongo_identity_after == "$mongo_identity_before" ]] || die 'Mongo identity changed during full rollback.'
[[ $(stable_live_compose_digest) == "$production_compose_sha256" ]] || die 'Production Compose changed during rollback.'
validate_backup_bundle "$backup_id" "$BACKUP_ROOT" >/dev/null
validate_recent_backup_bundle "$safety_backup_id" >/dev/null

active_temporary="${V7_ACTIVE_STATE}.tmp.$$"
{
  printf 'format_version=1\n'
  printf 'rollback_run=%s\n' "$run_id"
  printf 'deployment_run=%s\n' "$deployment_run"
  printf 'active_kind=%s\n' "$source_kind"
  printf 'active_image_id=%s\n' "$source_id"
  printf 'restored_backup_id=%s\n' "$backup_id"
  printf 'safety_backup_id=%s\n' "$safety_backup_id"
  printf 'activated_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$active_temporary"
chmod 0600 -- "$active_temporary"
mv -- "$active_temporary" "$V7_ACTIVE_STATE"

rm -f -- "$expected_summary" "$actual_summary"
current_phase='complete'
rollback_status='SUCCEEDED'
completed_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
recovery_action='not-required'
write_record "$state_file" status "$rollback_status"
write_record "$receipt_file" result 'SUCCEEDED'
support_emit "run=${run_id} result=SUCCEEDED full_rollback=${target_kind}-to-${source_kind} restored_backup_id=${backup_id} safety_backup_id=${safety_backup_id}"
sync -f "$run_dir"
sync -f "$log_dir"
rollback_succeeded=true
trap - EXIT INT TERM HUP
printf 'Full application-and-database rollback succeeded. Run ID: %s\n' "$run_id" >&3
printf 'Restored predeployment backup: %s\n' "$backup_id" >&3
printf 'Current-state safety backup retained: %s\n' "$safety_backup_id" >&3
printf 'Sanitized support log: %s\n' "$support_log" >&3
