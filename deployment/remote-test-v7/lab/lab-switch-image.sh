#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TITRA_LAB_LOCK_MODE='exclusive'
# shellcheck source=lock-bootstrap.sh
source "$SCRIPT_DIR/lock-bootstrap.sh"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  printf 'Usage: %s candidate|baseline\n' "$(basename -- "$0")" >&2
  exit 2
}

[[ "$#" == '1' ]] || usage
target="$1"
[[ "$target" == 'candidate' || "$target" == 'baseline' ]] || usage

prepare_operation exclusive
verify_release_images
ensure_state_directories
require_lab_safe_to_start

candidate_tag="${RELEASE_VALUES[TITRA_TEST_IMAGE]}"
candidate_id="$TITRA_RUNTIME_IMAGE_ID"
baseline_tag=''
baseline_id=''

if [[ -f "$BASELINE_STATE" ]]; then
  require_secure_root_file "$BASELINE_STATE"
  declare -A BASELINE_VALUES=()
  read_literal_env_file "$BASELINE_STATE" BASELINE_VALUES
  for key in "${!BASELINE_VALUES[@]}"; do
    case "$key" in
      format_version|baseline_image_tag|baseline_image_id|captured_at_utc)
        ;;
      *)
        die "Unexpected production baseline state key: $key"
        ;;
    esac
  done
  [[ "${BASELINE_VALUES[format_version]:-}" == '1' ]] || die 'Unsupported production baseline state format.'
  baseline_tag="${BASELINE_VALUES[baseline_image_tag]:-}"
  baseline_id="${BASELINE_VALUES[baseline_image_id]:-}"
  [[ "${BASELINE_VALUES[captured_at_utc]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die 'Baseline capture time is missing or invalid.'
  [[ "$baseline_tag" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'Baseline image tag is invalid.'
  [[ "$baseline_tag" != *:latest ]] || die 'A mutable latest baseline is not permitted.'
  [[ "$baseline_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Baseline image ID is invalid.'
  verify_image "$baseline_tag" "$baseline_id"
elif [[ "$target" == 'baseline' ]]; then
  die "Root preflight/capture has not created $BASELINE_STATE"
fi

if [[ "$target" == 'candidate' ]]; then
  selected_tag="$candidate_tag"
  selected_id="$candidate_id"
else
  selected_tag="$baseline_tag"
  selected_id="$baseline_id"
fi

[[ "$(container_health "$LAB_CONTAINER_DB")" == 'healthy' ]] || die 'The isolated lab MongoDB must be healthy before switching images.'
[[ "$(container_health "$LAB_CONTAINER_APP")" == 'healthy' ]] || die 'The isolated lab application must be healthy before switching images.'
verify_lab_resource_limits

old_tag="$(docker container inspect --format '{{.Config.Image}}' "$LAB_CONTAINER_APP")"
old_id="$(docker container inspect --format '{{.Image}}' "$LAB_CONTAINER_APP")"
if [[ "$old_id" != "$candidate_id" && ( -z "$baseline_id" || "$old_id" != "$baseline_id" ) ]]; then
  die "The lab is running an image that is neither the candidate nor the captured baseline: $old_id"
fi

db_container_before="$(docker container inspect --format '{{.Id}}' "$LAB_CONTAINER_DB")"
db_mount_before="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$LAB_CONTAINER_DB")"
[[ "$db_mount_before" == "$LAB_VOLUME|"* ]] || die 'The isolated MongoDB is not using the expected lab-only volume.'

if [[ "$old_id" == "$selected_id" ]]; then
  info "The lab is already running $target ($selected_tag)."
  exit 0
fi

wait_without_exit() {
  local container="$1" attempts="$2" status i
  for ((i = 1; i <= attempts; i++)); do
    status="$(container_health "$container")"
    [[ "$status" == 'healthy' ]] && return 0
    [[ "$status" == 'unhealthy' || "$status" == 'exited' || "$status" == 'dead' ]] && return 1
    sleep 2
  done
  return 1
}

rollback_lab_image() {
  info "Switch failed; returning the isolated lab to $old_tag ..." >&2
  export TITRA_TEST_IMAGE="$old_tag"
  compose up --detach --no-deps --force-recreate titra ingress >/dev/null || return 1
  wait_without_exit "$LAB_CONTAINER_APP" 90 || return 1
  wait_without_exit "$LAB_CONTAINER_INGRESS" 60 || return 1
  [[ "$(docker container inspect --format '{{.Image}}' "$LAB_CONTAINER_APP")" == "$old_id" ]] || return 1
  [[ "$(docker container inspect --format '{{.Image}}' "$LAB_CONTAINER_INGRESS")" == "$old_id" ]] || return 1
  if ! (
    verify_lab_runtime_isolation
    verify_lab_resource_limits
  ); then
    return 1
  fi
  [[ "$(docker container inspect --format '{{.Id}}' "$LAB_CONTAINER_DB")" == "$db_container_before" ]] || return 1
  [[ "$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$LAB_CONTAINER_DB")" == "$db_mount_before" ]] || return 1
}

info "Switching only the isolated lab from $old_tag to $selected_tag ..."
require_lab_frontend_stopped
export TITRA_TEST_IMAGE="$selected_tag"
if ! compose up --detach --no-deps --force-recreate titra >/dev/null \
  || ! wait_without_exit "$LAB_CONTAINER_APP" 90 \
  || ! compose up --detach --no-deps --force-recreate ingress >/dev/null \
  || ! wait_without_exit "$LAB_CONTAINER_INGRESS" 60; then
  compose logs --tail 80 titra ingress >&2 || true
  if ! rollback_lab_image; then
    stop_and_verify_lab_frontend \
      || die 'CRITICAL: lab image switch/rollback failed and ingress/app could not be proven stopped; production was not touched.'
    die 'Lab image switch and automatic rollback both failed; lab ingress/app were stopped and production was not touched.'
  fi
  die 'Lab image switch failed and was rolled back.'
fi

if ! (
  verify_running_container_image "$LAB_CONTAINER_APP" "$selected_id"
  verify_running_container_image "$LAB_CONTAINER_INGRESS" "$selected_id"
  verify_lab_runtime_isolation
  verify_lab_resource_limits
  [[ "$(docker container inspect --format '{{.Id}}' "$LAB_CONTAINER_DB")" == "$db_container_before" ]] \
    || die 'The lab MongoDB container identity changed unexpectedly.'
  [[ "$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$LAB_CONTAINER_DB")" == "$db_mount_before" ]] \
    || die 'The lab MongoDB mount identity changed unexpectedly.'
); then
  stop_and_verify_lab_frontend \
    || die 'CRITICAL: post-switch safety verification failed and ingress/app could not be proven stopped; production was not touched.'
  die 'Post-switch safety verification failed; lab ingress/app were stopped and production was not touched.'
fi
db_container_after="$(docker container inspect --format '{{.Id}}' "$LAB_CONTAINER_DB")"
db_mount_after="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$LAB_CONTAINER_DB")"

switch_id="$(date -u +'%Y%m%dT%H%M%SZ')"
install -d -o root -g root -m 0700 "$STATE_DIR/switches"
receipt_partial="$STATE_DIR/switches/.$switch_id.partial"
receipt="$STATE_DIR/switches/$switch_id.env"
[[ ! -e "$receipt_partial" && ! -e "$receipt" ]] || die "Switch receipt destination already exists: $switch_id"
printf 'format_version=1\nswitched_at_utc=%s\ntarget=%s\nfrom_image_tag=%s\nfrom_image_id=%s\nto_image_tag=%s\nto_image_id=%s\nlab_mongo_container_id=%s\nlab_mongo_mount=%s\n' \
  "$switch_id" "$target" "$old_tag" "$old_id" "$selected_tag" "$selected_id" "$db_container_after" "$db_mount_after" > "$receipt_partial"
mv -- "$receipt_partial" "$receipt"

info "The isolated lab now runs $target ($selected_tag)."
info "MongoDB container and volume identities were unchanged. Receipt: $receipt"
