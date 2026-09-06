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

--preview performs a read-only early warning check while the current Titra
application remains available. It cannot close the application-write race.

--require-app-stopped is the authoritative v7 switch gate. It is accepted only
under an inherited exclusive operator lock and requires the proven production
Titra container to be stopped while MongoDB remains running.

This check never prints user IDs or task names and never changes MongoDB.
EOF
}

mode=''
while (( $# > 0 )); do
  case $1 in
    --preview)
      [[ -z $mode ]] || die 'Choose exactly one personal-suggestion preflight mode.'
      mode='preview'
      shift
      ;;
    --require-app-stopped)
      [[ -z $mode ]] || die 'Choose exactly one personal-suggestion preflight mode.'
      mode='stopped'
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die 'Unknown personal-suggestion preflight argument.'
      ;;
  esac
done
[[ -n $mode ]] || {
  usage >&2
  die 'A personal-suggestion preflight mode is required.'
}

require_root
acquire_shared_lock
require_secure_installation
validate_production_context
require_secure_regular_file "${SCRIPT_DIR}/personal-task-suggestion-preflight.cjs"
require_command grep
require_command mktemp

[[ $(container_value "$DB_CONTAINER" '{{.State.Running}}') == 'true' ]] ||
  die 'Production MongoDB must be running for the personal-suggestion preflight.'

if [[ $mode == 'stopped' ]]; then
  [[ $LOCK_INHERITED == true ]] ||
    die 'The stopped-application preflight requires the inherited exclusive operator lock.'
  [[ $(container_value "$APP_CONTAINER" '{{ index .Config.Labels "com.docker.compose.project" }}') == "$PROD_PROJECT" &&
    $(container_value "$APP_CONTAINER" '{{ index .Config.Labels "com.docker.compose.service" }}') == "$APP_SERVICE" &&
    $(container_value "$APP_CONTAINER" '{{.Name}}') == "/${APP_CONTAINER}" ]] ||
    die 'The stopped application container identity cannot be proven.'
  [[ $(container_value "$APP_CONTAINER" '{{.State.Running}}') == 'false' ]] ||
    die 'The authoritative personal-suggestion preflight requires Titra to be stopped.'
else
  container_is_running "$APP_CONTAINER" ||
    die 'The preview preflight expects the current Titra application to be running.'
fi

mongo_before=$(mongo_identity_snapshot)
output_file=$(mktemp --tmpdir=/run 'titra-v7-suggestion-preflight.XXXXXXXX')
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
  < "${SCRIPT_DIR}/personal-task-suggestion-preflight.cjs" \
  > "$output_file" 2>&1
mongo_status=$?
set -e

assert_mongo_identity "$mongo_before" 'after the personal-suggestion duplicate preflight'
mapfile -t marker_lines < <(grep -E \
  '^TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT status=(PASS|DUPLICATES) index_status=(ABSENT|EXACT) duplicate_groups=[0-9]+ duplicate_documents=[0-9]+ excess_documents=[0-9]+$' \
  "$output_file" || true)
[[ ${#marker_lines[@]} -eq 1 ]] ||
  die "Personal task suggestion preflight failed without a valid sanitized result (mongosh status ${mongo_status})."

marker=${marker_lines[0]}
if [[ $mongo_status -eq 0 &&
  $marker =~ ^TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT\ status=PASS\ index_status=(ABSENT|EXACT)\ duplicate_groups=0\ duplicate_documents=0\ excess_documents=0$ ]]; then
  printf 'Personal task suggestion uniqueness preflight passed (%s mode).\n' "$mode"
  exit 0
fi

if [[ $mongo_status -eq 42 &&
  $marker =~ ^TITRA_V7_PERSONAL_SUGGESTION_PREFLIGHT\ status=DUPLICATES\ index_status=(ABSENT|EXACT)\ duplicate_groups=([0-9]+)\ duplicate_documents=([0-9]+)\ excess_documents=([0-9]+)$ ]]; then
  printf 'ERROR: v7 cannot start safely: duplicate personal task suggestions exist (groups=%s, documents=%s, excess=%s).\n' \
    "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}" >&2
  printf 'No MongoDB data was changed. Resolve duplicates through a separately reviewed repair procedure, take a fresh backup, and rerun the complete deployment preview.\n' >&2
  exit 1
fi

die "Personal task suggestion preflight returned an inconsistent sanitized result (mongosh status ${mongo_status})."
