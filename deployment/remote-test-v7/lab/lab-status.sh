#!/bin/bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TITRA_LAB_LOCK_MODE='shared'
# shellcheck source=lock-bootstrap.sh
source "$SCRIPT_DIR/lock-bootstrap.sh"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

prepare_operation shared
candidate_id="$(loaded_candidate_image_id)"

printf 'Lab project: %s\n' "$LAB_PROJECT"
printf 'Candidate:   Titra %s (%s)\n' "${RELEASE_VALUES[TITRA_VERSION]}" "${RELEASE_VALUES[SOURCE_COMMIT]}"
printf 'Image:       %s\n' "${RELEASE_VALUES[TITRA_TEST_IMAGE]}"
printf 'Loaded ID:   %s\n' "$candidate_id"
printf 'Allowed IDs: %s\n' "$(release_candidate_image_id_allowlist)"
printf 'Mongo image: %s\n' "${RELEASE_VALUES[MONGO_TEST_IMAGE]}"
printf 'Listen:      127.0.0.1:%s (remote host only)\n' "$LAB_PORT"
printf 'Database:    %s, isolated volume %s\n\n' "$LAB_DATABASE" "$LAB_VOLUME"
printf 'Limits:      app 1 GiB/1 CPU/256 PIDs; Mongo 1.5 GiB/1 CPU/256 PIDs; ingress 128 MiB/0.25 CPU/64 PIDs\n'
printf 'Reboot:      automatic restart disabled for every lab container\n\n'

if restore_unsafe_marker_exists; then
  printf 'WARNING: lab app start/switch is blocked by unresolved restore marker %s\n\n' "$RESTORE_UNSAFE_MARKER" >&2
fi

if docker container inspect "$LAB_CONTAINER_APP" >/dev/null 2>&1; then
  printf 'Running app: %s\n' "$(docker container inspect --format '{{.Config.Image}} ({{.Image}})' "$LAB_CONTAINER_APP")"
fi

compose ps --all

if [[ "$(container_health "$LAB_CONTAINER_DB")" == 'healthy' ]]; then
  collections="$(compose exec --no-TTY mongodb mongosh --quiet --eval "db.getSiblingDB('$LAB_DATABASE').getCollectionNames().length")"
  printf '\nLab database collections: %s\n' "$collections"
fi
