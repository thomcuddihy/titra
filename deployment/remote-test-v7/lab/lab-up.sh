#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TITRA_LAB_LOCK_MODE='exclusive'
# shellcheck source=lock-bootstrap.sh
source "$SCRIPT_DIR/lock-bootstrap.sh"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

prepare_operation exclusive
verify_release_images
ensure_state_directories
require_lab_safe_to_start
require_lab_host_capacity
require_lab_disk_capacity

info 'Starting the isolated Titra lab...'
compose config --quiet
lab_started=false
cleanup_failed_start() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ "$rc" -ne 0 && "$lab_started" == 'true' ]]; then
    info 'Lab start failed; stopping lab containers while preserving the lab volume.' >&2
    if ! stop_and_verify_lab_frontend; then
      info 'CRITICAL: failed to prove that lab ingress and app are stopped after the start failure.' >&2
    fi
    if ! compose down --remove-orphans >/dev/null 2>&1; then
      info 'CRITICAL: failed to remove all failed-start lab containers; production was not touched.' >&2
    fi
  fi
  exit "$rc"
}
trap cleanup_failed_start EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
lab_started=true
compose up --detach
verify_lab_runtime_isolation

wait_for_healthy "$LAB_CONTAINER_DB" mongodb 60
wait_for_healthy "$LAB_CONTAINER_APP" titra 90
wait_for_healthy "$LAB_CONTAINER_INGRESS" ingress 60

verify_running_container_image "$LAB_CONTAINER_DB" "$MONGO_RUNTIME_IMAGE_ID"
verify_running_container_image "$LAB_CONTAINER_APP" "$TITRA_RUNTIME_IMAGE_ID"
verify_running_container_image "$LAB_CONTAINER_INGRESS" "$TITRA_RUNTIME_IMAGE_ID"
verify_lab_resource_limits

mongo_version="$(compose exec --no-TTY mongodb mongod --version | sed -n 's/^db version v//p' | head -n 1)"
[[ "$mongo_version" == '7.0.40' ]] || die "Unexpected MongoDB runtime version: ${mongo_version:-unknown}"

lab_started=false
trap - EXIT INT TERM
info 'The isolated lab is healthy.'
info "Open it through an SSH tunnel at http://localhost:$LAB_PORT"
