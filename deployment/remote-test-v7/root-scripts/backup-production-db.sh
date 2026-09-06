#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"
require_root
acquire_shared_lock

usage() {
  cat <<EOF
Usage:
  $0 --ticket CHANGE_ID --dry-run
  $0 --ticket CHANGE_ID --confirm 'BACK UP PRODUCTION TITRA ON ${EXPECTED_HOST_FQDN}'
  $0 --ticket CHANGE_ID --leave-app-stopped --confirm 'BACK UP PRODUCTION TITRA ON ${EXPECTED_HOST_FQDN}'

--leave-app-stopped is accepted only under an inherited exclusive operator
lock. On success it hands the exact stopped application back to the parent
deployment so the dump remains the switch snapshot. On failure, cleanup still
attempts to restart the exact source container safely.
EOF
}

ticket=''
confirmation=''
dry_run=false
leave_app_stopped=false
while (( $# > 0 )); do
  case $1 in
    --ticket)
      (( $# >= 2 )) || die '--ticket requires a value.'
      ticket=$2
      shift 2
      ;;
    --confirm)
      (( $# >= 2 )) || die '--confirm requires a value.'
      confirmation=$2
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --leave-app-stopped)
      leave_app_stopped=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n $ticket ]] || die '--ticket is required.'
validate_safe_token 'change ticket' "$ticket"
if [[ $leave_app_stopped == true ]]; then
  [[ $LOCK_INHERITED == true ]] ||
    die '--leave-app-stopped requires an inherited exclusive operator lock.'
fi
validate_production_context
require_secure_directory "$BACKUP_ROOT"
container_is_running "$APP_CONTAINER" || die 'Production Titra is not currently running.'
require_backup_capacity "$BACKUP_ROOT"

expected_confirmation="BACK UP PRODUCTION TITRA ON ${EXPECTED_HOST_FQDN}"
if [[ $dry_run == true ]]; then
  [[ -z $confirmation ]] || die '--confirm cannot be combined with --dry-run.'
  printf 'Dry run passed. A real backup will briefly stop only %s, leave %s running,\n' \
    "$APP_CONTAINER" "$DB_CONTAINER"
  if [[ $leave_app_stopped == true ]]; then
    printf 'write an atomic checksum-verified mongodump bundle under %s, and leave the exact Titra container stopped for its parent deployment.\n' \
      "$BACKUP_ROOT"
  else
    printf 'write an atomic checksum-verified mongodump bundle under %s, and restart Titra.\n' \
      "$BACKUP_ROOT"
  fi
  printf 'Required confirmation: %s\n' "$expected_confirmation"
  exit 0
fi

[[ $confirmation == "$expected_confirmation" ]] ||
  die "Confirmation mismatch. Required: ${expected_confirmation}"
acquire_exclusive_lock
if [[ $leave_app_stopped == true ]]; then
  [[ $LOCK_INHERITED == true ]] ||
    die '--leave-app-stopped lost its inherited exclusive operator lock.'
fi
validate_production_context
require_secure_directory "$BACKUP_ROOT"
container_is_running "$APP_CONTAINER" || die 'Production Titra stopped before the lock was acquired.'
require_backup_capacity "$BACKUP_ROOT"
expected_app_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
expected_mongo_identity=$(mongo_identity_snapshot)

app_stopped=false
backup_completed=false
cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ $app_stopped == true ]]; then
    if [[ $(container_value "$APP_CONTAINER" '{{.Id}}' 2>/dev/null || true) != "$expected_app_container_id" ]]; then
      warn 'The exact Titra container was replaced; refusing to start an unknown container.'
      rc=1
    elif [[ $(mongo_identity_snapshot) != "$expected_mongo_identity" ]]; then
      stop_exact_app_if_running "$expected_app_container_id" ||
        warn 'Unable to prove the exact Titra container is stopped after Mongo identity drift.'
      warn 'Mongo identity changed during backup; Titra is intentionally left stopped.'
      rc=1
    elif container_is_running "$APP_CONTAINER"; then
      if wait_for_app 180; then
        app_stopped=false
      else
        stop_exact_app_if_running "$expected_app_container_id" ||
          warn 'Unable to prove the failed-readiness Titra container is stopped.'
        rc=1
      fi
    else
      log 'Restarting the exact existing production Titra container.'
      if start_existing_app_container "$expected_app_container_id"; then
        app_stopped=false
      else
        warn "Titra failed to become responsive after restart. Inspect ${APP_CONTAINER} immediately."
        rc=1
      fi
    fi
  fi
  if [[ $backup_completed != true && $rc -ne 0 ]]; then
    warn 'The backup did not complete. Any .partial directory was intentionally retained for inspection.'
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

log 'Stopping only the production Titra application to quiesce database writes.'
stop_app_for_database_work
app_stopped=true
assert_exact_app_stopped "$expected_app_container_id"
assert_mongo_identity "$expected_mongo_identity" 'after stopping Titra'

backup_path=$(create_database_backup_bundle "$BACKUP_ROOT" 'prod' \
  'consistent-production-backup' "$ticket")
assert_exact_app_stopped "$expected_app_container_id"
assert_mongo_identity "$expected_mongo_identity" 'after summary, dump, and dry-run verification'
backup_completed=true

if [[ $leave_app_stopped == true ]]; then
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'before stopped-state handoff to the parent deployment'
  # Successful ownership transfer only: the parent holds the same exclusive
  # lock and is now responsible for restart-on-failure or the image switch.
  app_stopped=false
  log 'Leaving the exact production Titra container stopped for the parent deployment.'
else
  log 'Restarting the existing production Titra container.'
  start_existing_app_container "$expected_app_container_id" ||
    die 'Backup succeeded, but Titra failed to become responsive and was stopped.'
  assert_exact_app_running "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'after restarting Titra'
  app_stopped=false
fi

printf 'Completed production backup: %s\n' "$backup_path"
printf 'Archive: %s/%s\n' "$backup_path" "$BACKUP_ARCHIVE"
printf 'Checksum: %s/%s\n' "$backup_path" "$BACKUP_CHECKSUM"
printf 'Manifest: %s/%s\n' "$backup_path" "$BACKUP_MANIFEST"
if [[ $leave_app_stopped == true ]]; then
  printf 'Application handoff: exact source container remains stopped\n'
fi
