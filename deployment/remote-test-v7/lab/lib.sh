#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
umask 077

unset CDPATH ENV BASH_ENV COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
unset COMPOSE_ENV_FILES COMPOSE_PROFILES DOCKER_CONTEXT
export DOCKER_HOST='unix:///var/run/docker.sock'

LAB_PROJECT='titra_v7_lab'
LAB_DATABASE='titra_v7_lab'
LAB_PORT='33026'
LAB_CONTAINER_APP='titra_v7_lab_app'
LAB_CONTAINER_DB='titra_v7_lab_db'
LAB_CONTAINER_INGRESS='titra_v7_lab_ingress'
LAB_VOLUME='titra_v7_lab_mongo_data'
LAB_NETWORK_BACKPLANE='titra_v7_lab_backplane'
LAB_NETWORK_INGRESS='titra_v7_lab_ingress'
LAB_LABEL='io.titra.remote-test.scope=isolated-lab'
PRODUCTION_PROJECT='__V7_PROD_PROJECT__'
PRODUCTION_APP_SERVICE='__V7_APP_SERVICE__'
PRODUCTION_DB_SERVICE='__V7_DB_SERVICE__'
PRODUCTION_APP_CONTAINER='__V7_APP_CONTAINER__'
PRODUCTION_DB_CONTAINER='__V7_DB_CONTAINER__'
PRODUCTION_DATABASE='__V7_PROD_DATABASE__'
EXPECTED_HOST_FQDN='__V7_EXPECTED_HOST_FQDN__'
EXPECTED_PRODUCTION_COMPOSE_SHA256='__V7_PROD_COMPOSE_SHA256__'
BACKUP_FORMAT_VERSION='2'

LAB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$LAB_DIR/.." && pwd -P)"
COMPOSE_FILE="$LAB_DIR/compose.yml"
RELEASE_ENV="$PACKAGE_ROOT/manifest/release.env"
STATE_DIR='__V7_STATE_ROOT__/lab'
RESTORE_UNSAFE_MARKER="$STATE_DIR/RESTORE-UNSAFE.env"
LOCK_DIR='__V7_LOCK_DIR__'
LOCK_FILE="$LOCK_DIR/operator.lock"
LAB_BACKUP_ROOT='__V7_BACKUP_ROOT__/lab'
PRODUCTION_BACKUP_ROOT='__V7_BACKUP_ROOT__/production'
BASELINE_STATE='__V7_STATE_ROOT__/production-baseline.env'
LOADED_CANDIDATE_STATE='__V7_STATE_ROOT__/production-images/loaded-v7.env'
LOADED_MONGO_STATE='__V7_STATE_ROOT__/production-images/loaded-mongo-v7.env'
V7_RUNTIME_CONFIG='__V7_STATE_ROOT__/v7-runtime.env'
GIB_BYTES=1073741824
LAB_MEMORY_LIMIT_BYTES=2818572288
PRODUCTION_MEMORY_HEADROOM_BYTES=2147483648
LAB_MINIMUM_RAM_WORKING_BYTES=1073741824
LAB_CPU_LIMIT_HUNDREDTHS=225
PRODUCTION_CPU_HEADROOM_HUNDREDTHS=100
PRODUCTION_DISK_HEADROOM_MINIMUM_BYTES=5368709120

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

require_root() {
  [[ "$(id -u)" == '0' ]] || die 'Run this command as root.'
}

canonical_hostname() {
  hostname --fqdn | tr '[:upper:]' '[:lower:]' | sed 's/[.]$//'
}

validate_expected_host() {
  local actual
  actual="$(canonical_hostname)" || die 'Unable to determine the host FQDN.'
  [[ "$actual" == "$EXPECTED_HOST_FQDN" ]] || die "Wrong host. Expected $EXPECTED_HOST_FQDN; found ${actual:-unknown}."
}

require_trusted_package() {
  local path owner mode numeric
  path="$(realpath -e -- "$PACKAGE_ROOT")"

  while [[ "$path" != '/' ]]; do
    IFS=' ' read -r owner mode < <(stat -Lc '%u %a' -- "$path")
    [[ "$owner" == '0' ]] || die "Package path is not root-owned: $path"
    numeric=$((8#$mode))
    (( (numeric & 0022) == 0 )) || die "Package path is group/other writable: $path"
    path="$(dirname -- "$path")"
  done

  for path in "$LAB_DIR" "$(dirname -- "$RELEASE_ENV")"; do
    [[ -d "$path" && ! -L "$path" ]] || die "Required package directory is missing or is a symlink: $path"
    IFS=' ' read -r owner mode < <(stat -Lc '%u %a' -- "$path")
    [[ "$owner" == '0' ]] || die "Package directory is not root-owned: $path"
    numeric=$((8#$mode))
    (( (numeric & 0022) == 0 )) || die "Package directory is group/other writable: $path"
  done

  for path in "$COMPOSE_FILE" "$LAB_DIR/lib.sh" "$LAB_DIR/lock-bootstrap.sh" "$LAB_DIR/tcp-proxy.mjs" "$LAB_DIR/sanitize-clone.js" "$RELEASE_ENV"; do
    [[ -f "$path" && ! -L "$path" ]] || die "Required package file is missing or is a symlink: $path"
    IFS=' ' read -r owner mode < <(stat -Lc '%u %a' -- "$path")
    [[ "$owner" == '0' ]] || die "Package file is not root-owned: $path"
    numeric=$((8#$mode))
    (( (numeric & 0022) == 0 )) || die "Package file is group/other writable: $path"
  done
}

require_secure_root_file() {
  local path="$1" resolved owner mode numeric
  [[ -f "$path" && ! -L "$path" ]] || die "Required root state file is missing or unsafe: $path"
  resolved="$(realpath -e -- "$path")"
  while [[ "$resolved" != '/' ]]; do
    IFS=' ' read -r owner mode < <(stat -Lc '%u %a' -- "$resolved")
    [[ "$owner" == '0' ]] || die "Root state path is not root-owned: $resolved"
    numeric=$((8#$mode))
    (( (numeric & 0022) == 0 )) || die "Root state path is group/other writable: $resolved"
    resolved="$(dirname -- "$resolved")"
  done
}

acquire_lock() {
  local mode="${1:-exclusive}" owner file_mode
  [[ "$mode" == 'exclusive' || "$mode" == 'shared' ]] || die "Unexpected lock mode: $mode"
  if [[ -n "${TITRA_LAB_LOCK_HELD:-}" ]]; then
    [[ "$TITRA_LAB_LOCK_HELD" == 'exclusive' || ( "$TITRA_LAB_LOCK_HELD" == 'shared' && "$mode" == 'shared' ) ]] \
      || die "The early operator lock mode $TITRA_LAB_LOCK_HELD does not satisfy requested mode $mode."
    [[ "${TITRA_OPERATOR_LOCK_DIR:-}" == "$LOCK_DIR" && "${TITRA_OPERATOR_LOCK_FILE:-}" == "$LOCK_FILE" ]] \
      || die 'The early operator lock path does not match the lab library lock path.'
    [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "Lock directory became unsafe: $LOCK_DIR"
    IFS=' ' read -r owner file_mode < <(stat -Lc '%u %a' -- "$LOCK_DIR")
    [[ "$owner" == '0' && "$file_mode" == '700' ]] || die "Lock directory became unsafe: $LOCK_DIR"
    [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "Operator lock file became unsafe: $LOCK_FILE"
    IFS=' ' read -r owner file_mode < <(stat -Lc '%u %a' -- "$LOCK_FILE")
    [[ "$owner" == '0' && "$file_mode" == '600' && "$(stat -Lc '%h' -- "$LOCK_FILE")" == '1' ]] \
      || die "Operator lock file became unsafe: $LOCK_FILE"
    return 0
  fi

  [[ -d /run && ! -L /run ]] || die '/run is unavailable or unsafe.'
  [[ ! -L "$LOCK_DIR" ]] || die "Lock directory must not be a symlink: $LOCK_DIR"
  if [[ ! -e "$LOCK_DIR" ]]; then
    install -d -o root -g root -m 0700 -- "$LOCK_DIR"
  fi
  [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "Lock directory is not a direct directory: $LOCK_DIR"
  IFS=' ' read -r owner file_mode < <(stat -Lc '%u %a' -- "$LOCK_DIR")
  [[ "$owner" == '0' && "$file_mode" == '700' ]] || die "Lock directory must be root-owned mode 0700: $LOCK_DIR"
  [[ ! -L "$LOCK_FILE" ]] || die "Lock path must not be a symlink: $LOCK_FILE"
  if [[ ! -e "$LOCK_FILE" ]]; then
    (umask 077; : > "$LOCK_FILE")
  fi
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "Lock path is not a direct regular file: $LOCK_FILE"
  chown root:root -- "$LOCK_FILE"
  chmod 0600 -- "$LOCK_FILE"
  require_secure_root_file "$LOCK_FILE"
  [[ "$(stat -Lc '%h' -- "$LOCK_FILE")" == '1' ]] || die 'Operator lock file has unexpected hard links.'
  exec 9<>"$LOCK_FILE"
  if [[ "$mode" == 'shared' ]]; then
    flock --shared --nonblock 9 || die "Another Titra operator task holds $LOCK_FILE."
  else
    flock --exclusive --nonblock 9 || die "Another Titra operator task holds $LOCK_FILE."
  fi
}

declare -A RELEASE_VALUES=()
TITRA_RUNTIME_IMAGE_ID=''
MONGO_RUNTIME_IMAGE_ID=''

load_release_manifest() {
  local raw key value
  local -A seen=()
  local -A runtime=()

  [[ -f "$RELEASE_ENV" ]] || die "Release manifest is missing: $RELEASE_ENV"
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    [[ "$raw" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "Malformed release manifest line: $raw"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      RELEASE_FORMAT|PACKAGE_RELEASE_ID|RELEASE_PROFILE|TITRA_VERSION|TITRA_TEST_IMAGE|TITRA_TEST_IMAGE_ID|TITRA_CONFIG_IMAGE_ID|TITRA_IMAGE_ARCHIVE|MONGO_TEST_IMAGE|MONGO_TEST_IMAGE_ID|MONGO_CONFIG_IMAGE_ID|MONGO_SOURCE_DIGEST|MONGO_IMAGE_ARCHIVE|SOURCE_COMMIT|SOURCE_CONTEXT_SHA256|TITRA_IMAGE_EVIDENCE_DIRECTORY|TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256|STOCK_IMAGE|STOCK_IMAGE_ID|V5_IMAGE|V5_IMAGE_ID|V6_IMAGE|V6_IMAGE_ID|V6_CONFIG_IMAGE_ID|V6_IMAGE_ARCHIVE)
        ;;
      *)
      die "Unexpected release manifest key: $key"
        ;;
    esac
    [[ -z "${seen[$key]+x}" ]] || die "Duplicate release manifest key: $key"
    seen[$key]=1
    RELEASE_VALUES[$key]="$value"
  done < "$RELEASE_ENV"

  for key in RELEASE_FORMAT PACKAGE_RELEASE_ID RELEASE_PROFILE TITRA_VERSION TITRA_TEST_IMAGE TITRA_TEST_IMAGE_ID TITRA_CONFIG_IMAGE_ID TITRA_IMAGE_ARCHIVE MONGO_TEST_IMAGE MONGO_TEST_IMAGE_ID MONGO_CONFIG_IMAGE_ID MONGO_SOURCE_DIGEST MONGO_IMAGE_ARCHIVE SOURCE_COMMIT SOURCE_CONTEXT_SHA256 TITRA_IMAGE_EVIDENCE_DIRECTORY TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256 STOCK_IMAGE STOCK_IMAGE_ID V5_IMAGE V5_IMAGE_ID V6_IMAGE V6_IMAGE_ID V6_CONFIG_IMAGE_ID V6_IMAGE_ARCHIVE; do
    [[ -n "${RELEASE_VALUES[$key]:-}" ]] || die "Release manifest key is missing: $key"
  done

  [[ "${RELEASE_VALUES[RELEASE_FORMAT]}" == '7' ]] || die 'Unsupported release manifest format.'
  [[ "${RELEASE_VALUES[PACKAGE_RELEASE_ID]}" == '__V7_PACKAGE_RELEASE_ID__' ]] || die 'Unexpected package release ID.'
  [[ "${RELEASE_VALUES[TITRA_VERSION]}" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || die 'The lab Titra version is invalid.'
  [[ "${RELEASE_VALUES[RELEASE_PROFILE]}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die 'The lab release profile is invalid.'
  [[ "${RELEASE_VALUES[MONGO_TEST_IMAGE]}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] ||
    die 'The lab package Mongo image reference is invalid.'
  [[ "${RELEASE_VALUES[MONGO_SOURCE_DIGEST]}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die 'The lab package Mongo source digest is invalid.'
  [[ "${RELEASE_VALUES[TITRA_TEST_IMAGE]}" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'TITRA_TEST_IMAGE is not a valid immutable local tag.'
  [[ "${RELEASE_VALUES[TITRA_TEST_IMAGE]}" != *:latest ]] || die 'The latest tag is not permitted.'
  [[ "${RELEASE_VALUES[TITRA_TEST_IMAGE_ID]}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'TITRA_TEST_IMAGE_ID is invalid.'
  [[ "${RELEASE_VALUES[TITRA_CONFIG_IMAGE_ID]}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'TITRA_CONFIG_IMAGE_ID is invalid.'
  [[ "${RELEASE_VALUES[MONGO_TEST_IMAGE_ID]}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'MONGO_TEST_IMAGE_ID is invalid.'
  [[ "${RELEASE_VALUES[MONGO_CONFIG_IMAGE_ID]}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'MONGO_CONFIG_IMAGE_ID is invalid.'
  [[ "${RELEASE_VALUES[SOURCE_COMMIT]}" =~ ^[0-9a-f]{40}$ ]] || die 'SOURCE_COMMIT is invalid.'
  [[ "${RELEASE_VALUES[SOURCE_CONTEXT_SHA256]}" =~ ^[0-9a-f]{64}$ ]] || die 'SOURCE_CONTEXT_SHA256 is invalid.'
  [[ "${RELEASE_VALUES[TITRA_TEST_IMAGE]##*:}" == "${RELEASE_VALUES[TITRA_VERSION]}-${RELEASE_VALUES[SOURCE_COMMIT]:0:12}-ctx${RELEASE_VALUES[SOURCE_CONTEXT_SHA256]:0:12}-${RELEASE_VALUES[RELEASE_PROFILE]}-amd64" ]] ||
    die 'TITRA_TEST_IMAGE differs from the manifest provenance and release profile.'
  [[ "${RELEASE_VALUES[TITRA_IMAGE_EVIDENCE_DIRECTORY]}" == 'evidence/candidate-image' ]] ||
    die 'TITRA_IMAGE_EVIDENCE_DIRECTORY is invalid.'
  [[ "${RELEASE_VALUES[TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256]}" =~ ^[0-9a-f]{64}$ ]] ||
    die 'TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256 is invalid.'

  export TITRA_TEST_IMAGE="${RELEASE_VALUES[TITRA_TEST_IMAGE]}"
  export MONGO_TEST_IMAGE="${RELEASE_VALUES[MONGO_TEST_IMAGE]}"
  require_secure_root_file "$V7_RUNTIME_CONFIG"
  read_literal_env_file "$V7_RUNTIME_CONFIG" runtime
  [[ "${runtime[format_version]:-}" == '1' &&
    "${runtime[oauth_secret_key]:-}" =~ ^[A-Za-z0-9+/]{22}==$ ]] ||
    die 'V7 runtime configuration or OAuth encryption key is invalid.'
  export TITRA_OAUTH_SECRET_KEY="${runtime[oauth_secret_key]}"
  export TITRA_PRIVATE_INTEGRATION_HOSTS="${runtime[private_integration_hosts]:-}"
}

verify_image() {
  local tag="$1" expected_id="$2" actual_id
  actual_id="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)" || die "Required image has not been loaded: $tag"
  [[ "$actual_id" == "$expected_id" ]] || die "Image identity mismatch for $tag (expected $expected_id, found $actual_id)."
}

release_candidate_image_id_is_allowed() {
  local image_id="$1"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  [[ "$image_id" == "${RELEASE_VALUES[TITRA_TEST_IMAGE_ID]}" ||
    "$image_id" == "${RELEASE_VALUES[TITRA_CONFIG_IMAGE_ID]}" ]]
}

release_mongo_image_id_is_allowed() {
  local image_id="$1"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  [[ "$image_id" == "${RELEASE_VALUES[MONGO_TEST_IMAGE_ID]}" ||
    "$image_id" == "${RELEASE_VALUES[MONGO_CONFIG_IMAGE_ID]}" ]]
}

release_candidate_image_id_allowlist() {
  if [[ "${RELEASE_VALUES[TITRA_TEST_IMAGE_ID]}" == "${RELEASE_VALUES[TITRA_CONFIG_IMAGE_ID]}" ]]; then
    printf '%s\n' "${RELEASE_VALUES[TITRA_TEST_IMAGE_ID]}"
  else
    printf '%s,%s\n' "${RELEASE_VALUES[TITRA_TEST_IMAGE_ID]}" "${RELEASE_VALUES[TITRA_CONFIG_IMAGE_ID]}"
  fi
}

package_checksum_for_path() {
  local relative_path="$1" checksum_file="$PACKAGE_ROOT/SHA256SUMS" count digest
  [[ "$relative_path" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$relative_path" != *'..'* ]] ||
    die 'Cannot look up an unsafe package checksum path.'
  require_secure_root_file "$checksum_file"
  count="$(awk -v path="$relative_path" 'substr($0, 67) == path { count++ } END { print count + 0 }' "$checksum_file")"
  [[ "$count" == '1' ]] || die "Package checksum manifest must contain exactly one $relative_path record."
  digest="$(awk -v path="$relative_path" 'substr($0, 67) == path { print $1 }' "$checksum_file")"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Package checksum for $relative_path is invalid."
  printf '%s\n' "$digest"
}

loaded_candidate_image_id() {
  local keys archive_sha expected_archive_sha actual_id actual_loaded_id platform
  local -A loaded_state=()
  require_secure_root_file "$LOADED_CANDIDATE_STATE"
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$LOADED_CANDIDATE_STATE")" == '0:0:600:1' ]] ||
    die 'Loaded candidate state must be root:root mode 0600 with one hard link.'
  keys="$(awk -F= '{print $1}' "$LOADED_CANDIDATE_STATE" | paste -sd ',' -)"
  [[ "$keys" == 'format_version,package_release_id,target_kind,image_ref,actual_image_id,archive_sha256,loaded_at_utc' ]] ||
    die 'Loaded candidate state has an unexpected or reordered schema.'
  read_literal_env_file "$LOADED_CANDIDATE_STATE" loaded_state
  archive_sha="${loaded_state[archive_sha256]:-}"
  expected_archive_sha="$(package_checksum_for_path "${RELEASE_VALUES[TITRA_IMAGE_ARCHIVE]}")"
  actual_id="${loaded_state[actual_image_id]:-}"
  [[ "${loaded_state[format_version]:-}" == '1' &&
    "${loaded_state[package_release_id]:-}" == "${RELEASE_VALUES[PACKAGE_RELEASE_ID]}" &&
    "${loaded_state[target_kind]:-}" == 'v7' &&
    "${loaded_state[image_ref]:-}" == "${RELEASE_VALUES[TITRA_TEST_IMAGE]}" &&
    "$archive_sha" == "$expected_archive_sha" &&
    "${loaded_state[loaded_at_utc]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'Loaded candidate state does not match this checksum-bound release package.'
  release_candidate_image_id_is_allowed "$actual_id" ||
    die 'Loaded candidate state records an image ID outside the exact release-bound tested/config allowlist.'
  actual_loaded_id="$(docker image inspect --format '{{.Id}}' "${RELEASE_VALUES[TITRA_TEST_IMAGE]}" 2>/dev/null)" ||
    die 'The protected release candidate image is not loaded.'
  [[ "$actual_loaded_id" == "$actual_id" ]] ||
    die 'The candidate tag no longer resolves to the protected loaded candidate image ID.'
  platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${RELEASE_VALUES[TITRA_TEST_IMAGE]}")"
  [[ "$platform" == 'linux/amd64' ]] || die "Loaded candidate platform is $platform, not linux/amd64."
  printf '%s\n' "$actual_id"
}

loaded_mongo_image_id() {
  local keys archive_sha expected_archive_sha actual_id actual_loaded_id platform
  local -A loaded_state=()
  require_secure_root_file "$LOADED_MONGO_STATE"
  [[ "$(stat -Lc '%u:%g:%a:%h' -- "$LOADED_MONGO_STATE")" == '0:0:600:1' ]] ||
    die 'Loaded Mongo state must be root:root mode 0600 with one hard link.'
  keys="$(awk -F= '{print $1}' "$LOADED_MONGO_STATE" | paste -sd ',' -)"
  [[ "$keys" == 'format_version,package_release_id,target_kind,image_ref,actual_image_id,archive_sha256,loaded_at_utc' ]] ||
    die 'Loaded Mongo state has an unexpected or reordered schema.'
  read_literal_env_file "$LOADED_MONGO_STATE" loaded_state
  archive_sha="${loaded_state[archive_sha256]:-}"
  expected_archive_sha="$(package_checksum_for_path "${RELEASE_VALUES[MONGO_IMAGE_ARCHIVE]}")"
  actual_id="${loaded_state[actual_image_id]:-}"
  [[ "${loaded_state[format_version]:-}" == '1' &&
    "${loaded_state[package_release_id]:-}" == "${RELEASE_VALUES[PACKAGE_RELEASE_ID]}" &&
    "${loaded_state[target_kind]:-}" == 'mongo' &&
    "${loaded_state[image_ref]:-}" == "${RELEASE_VALUES[MONGO_TEST_IMAGE]}" &&
    "$archive_sha" == "$expected_archive_sha" &&
    "${loaded_state[loaded_at_utc]:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'Loaded Mongo state does not match this checksum-bound release package.'
  release_mongo_image_id_is_allowed "$actual_id" ||
    die 'Loaded Mongo state records an image ID outside its tested/config allowlist.'
  actual_loaded_id="$(docker image inspect --format '{{.Id}}' "${RELEASE_VALUES[MONGO_TEST_IMAGE]}" 2>/dev/null)" ||
    die 'The protected Mongo lab image is not loaded.'
  [[ "$actual_loaded_id" == "$actual_id" ]] ||
    die 'The Mongo tag no longer resolves to its protected loaded image ID.'
  platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${RELEASE_VALUES[MONGO_TEST_IMAGE]}")"
  [[ "$platform" == 'linux/amd64' ]] || die "Loaded Mongo platform is $platform, not linux/amd64."
  printf '%s\n' "$actual_id"
}

verify_release_images() {
  TITRA_RUNTIME_IMAGE_ID="$(loaded_candidate_image_id)"
  MONGO_RUNTIME_IMAGE_ID="$(loaded_mongo_image_id)"
  verify_image "${RELEASE_VALUES[TITRA_TEST_IMAGE]}" "$TITRA_RUNTIME_IMAGE_ID"
  verify_image "${RELEASE_VALUES[MONGO_TEST_IMAGE]}" "$MONGO_RUNTIME_IMAGE_ID"
}

assert_compose_identity() {
  local kind name project scope
  kind="$1"
  name="$2"

  if ! docker "$kind" inspect "$name" >/dev/null 2>&1; then
    return 0
  fi

  case "$kind" in
    container)
      project="$(docker container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$name")"
      scope="$(docker container inspect --format '{{ index .Config.Labels "io.titra.remote-test.scope" }}' "$name")"
      ;;
    network|volume)
      project="$(docker "$kind" inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$name")"
      scope="$(docker "$kind" inspect --format '{{ index .Labels "io.titra.remote-test.scope" }}' "$name")"
      ;;
    *)
      die "Unsupported Docker object kind: $kind"
      ;;
  esac

  [[ "$project" == "$LAB_PROJECT" && "$scope" == 'isolated-lab' ]] || die "Refusing to use pre-existing Docker $kind with unexpected ownership: $name"
}

verify_lab_object_names() {
  assert_compose_identity container "$LAB_CONTAINER_APP"
  assert_compose_identity container "$LAB_CONTAINER_DB"
  assert_compose_identity container "$LAB_CONTAINER_INGRESS"
  assert_compose_identity volume "$LAB_VOLUME"
  assert_compose_identity network "$LAB_NETWORK_BACKPLANE"
  assert_compose_identity network "$LAB_NETWORK_INGRESS"
}

container_project_label() {
  docker container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$1"
}

container_service_label() {
  docker container inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$1"
}

container_network_count() {
  docker container inspect --format '{{len .NetworkSettings.Networks}}' "$1"
}

container_has_network() {
  local container="$1" network="$2"
  [[ "$(docker container inspect --format "{{if index .NetworkSettings.Networks \"$network\"}}yes{{end}}" "$container")" == 'yes' ]]
}

container_port_bindings() {
  docker container inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{$port}}={{len $bindings}};{{end}}' "$1"
}

verify_production_separation() {
  local production_mount production_volume production_source lab_mountpoint lab_container_mount
  local container network network_id lab_network_id lab_container_id production_container_id

  for container in "$PRODUCTION_APP_CONTAINER" "$PRODUCTION_DB_CONTAINER"; do
    docker container inspect "$container" >/dev/null 2>&1 || die "Cannot prove lab separation because production container is missing: $container"
    [[ "$(container_project_label "$container")" == "$PRODUCTION_PROJECT" ]] || die "Unexpected production project label on $container"
  done
  [[ "$(container_service_label "$PRODUCTION_APP_CONTAINER")" == "$PRODUCTION_APP_SERVICE" ]] || die 'Unexpected production app service identity.'
  [[ "$(container_service_label "$PRODUCTION_DB_CONTAINER")" == "$PRODUCTION_DB_SERVICE" ]] || die 'Unexpected production Mongo service identity.'

  production_mount="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$PRODUCTION_DB_CONTAINER")"
  [[ "$production_mount" == *'|'* ]] || die 'Cannot identify the production MongoDB /data/db mount.'
  production_volume="${production_mount%%|*}"
  production_source="${production_mount#*|}"
  [[ -n "$production_volume" && -n "$production_source" ]] || die 'Production MongoDB does not use the expected named volume.'
  [[ "$production_volume" != "$LAB_VOLUME" ]] || die 'Production and lab MongoDB volume names collide.'

  for container in "$PRODUCTION_APP_CONTAINER" "$PRODUCTION_DB_CONTAINER"; do
    for network in "$LAB_NETWORK_BACKPLANE" "$LAB_NETWORK_INGRESS"; do
      ! container_has_network "$container" "$network" || die "Production container $container is attached to lab network $network"
    done
  done

  if docker volume inspect "$LAB_VOLUME" >/dev/null 2>&1; then
    lab_mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$LAB_VOLUME")"
    [[ "$lab_mountpoint" != "$production_source" ]] || die 'Production and lab MongoDB resolve to the same volume mountpoint.'
  fi

  if docker container inspect "$LAB_CONTAINER_DB" >/dev/null 2>&1; then
    lab_container_id="$(docker container inspect --format '{{.Id}}' "$LAB_CONTAINER_DB")"
    production_container_id="$(docker container inspect --format '{{.Id}}' "$PRODUCTION_DB_CONTAINER")"
    [[ "$lab_container_id" != "$production_container_id" ]] || die 'Production and lab MongoDB container identities collide.'
    lab_container_mount="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Name}}|{{.Source}}{{end}}{{end}}' "$LAB_CONTAINER_DB")"
    [[ "$lab_container_mount" == "$LAB_VOLUME|"* ]] || die 'Lab MongoDB is not mounted from the fixed lab-only volume.'
    [[ "$lab_container_mount" != "$production_mount" ]] || die 'Production and lab MongoDB containers use the same mount.'
  fi

  for network in "$LAB_NETWORK_BACKPLANE" "$LAB_NETWORK_INGRESS"; do
    if docker network inspect "$network" >/dev/null 2>&1; then
      lab_network_id="$(docker network inspect --format '{{.Id}}' "$network")"
      while IFS= read -r network; do
        [[ -n "$network" ]] || continue
        network_id="$(docker network inspect --format '{{.Id}}' "$network")"
        [[ "$network_id" != "$lab_network_id" ]] || die "Production and lab Docker network identities collide: $network"
      done < <(docker container inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$PRODUCTION_DB_CONTAINER")
    fi
  done
}

verify_existing_lab_runtime_isolation() {
  local member ingress_binding

  if docker container inspect "$LAB_CONTAINER_APP" >/dev/null 2>&1; then
    [[ "$(container_network_count "$LAB_CONTAINER_APP")" == '1' ]] || die 'Lab Titra is attached to an unexpected number of networks.'
    container_has_network "$LAB_CONTAINER_APP" "$LAB_NETWORK_BACKPLANE" || die 'Lab Titra is not attached to its internal backplane.'
    [[ -z "$(container_port_bindings "$LAB_CONTAINER_APP")" ]] || die 'Lab Titra must not publish a host port directly.'
  fi

  if docker container inspect "$LAB_CONTAINER_DB" >/dev/null 2>&1; then
    [[ "$(container_network_count "$LAB_CONTAINER_DB")" == '1' ]] || die 'Lab MongoDB is attached to an unexpected number of networks.'
    container_has_network "$LAB_CONTAINER_DB" "$LAB_NETWORK_BACKPLANE" || die 'Lab MongoDB is not attached to its internal backplane.'
    [[ -z "$(container_port_bindings "$LAB_CONTAINER_DB")" ]] || die 'Lab MongoDB must not publish a host port.'
  fi

  if docker network inspect "$LAB_NETWORK_BACKPLANE" >/dev/null 2>&1; then
    [[ "$(docker network inspect --format '{{.Internal}}' "$LAB_NETWORK_BACKPLANE")" == 'true' ]] || die 'Lab backplane is not an internal Docker network.'
    while IFS= read -r member; do
      case "$member" in
        ''|"$LAB_CONTAINER_APP"|"$LAB_CONTAINER_DB"|"$LAB_CONTAINER_INGRESS")
          ;;
        *)
          die "Unexpected container on the lab backplane: $member"
          ;;
      esac
    done < <(docker network inspect --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' "$LAB_NETWORK_BACKPLANE")
  fi

  if docker container inspect "$LAB_CONTAINER_INGRESS" >/dev/null 2>&1; then
    [[ "$(container_network_count "$LAB_CONTAINER_INGRESS")" == '2' ]] || die 'Lab ingress is attached to an unexpected number of networks.'
    container_has_network "$LAB_CONTAINER_INGRESS" "$LAB_NETWORK_BACKPLANE" || die 'Lab ingress is missing its backplane attachment.'
    container_has_network "$LAB_CONTAINER_INGRESS" "$LAB_NETWORK_INGRESS" || die 'Lab ingress is missing its ingress-network attachment.'
    ingress_binding="$(docker container inspect --format '{{with index .HostConfig.PortBindings "8080/tcp"}}{{len .}}|{{(index . 0).HostIp}}|{{(index . 0).HostPort}}{{end}}' "$LAB_CONTAINER_INGRESS")"
    [[ "$ingress_binding" == '1|127.0.0.1|33026' ]] || die "Lab ingress binding is not exactly 127.0.0.1:33026: $ingress_binding"
    [[ "$(container_port_bindings "$LAB_CONTAINER_INGRESS")" == '8080/tcp=1;' ]] || die 'Lab ingress has an unexpected additional port binding.'
  fi

  if docker network inspect "$LAB_NETWORK_INGRESS" >/dev/null 2>&1; then
    [[ "$(docker network inspect --format '{{.Internal}}' "$LAB_NETWORK_INGRESS")" == 'false' ]] || die 'Lab ingress network has an unexpected internal setting.'
    while IFS= read -r member; do
      [[ -z "$member" || "$member" == "$LAB_CONTAINER_INGRESS" ]] || die "Unexpected container on the lab ingress network: $member"
    done < <(docker network inspect --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' "$LAB_NETWORK_INGRESS")
  fi
}

verify_lab_runtime_isolation() {
  for container in "$LAB_CONTAINER_APP" "$LAB_CONTAINER_DB" "$LAB_CONTAINER_INGRESS"; do
    docker container inspect "$container" >/dev/null 2>&1 || die "Expected lab container is missing: $container"
  done
  for network in "$LAB_NETWORK_BACKPLANE" "$LAB_NETWORK_INGRESS"; do
    docker network inspect "$network" >/dev/null 2>&1 || die "Expected lab network is missing: $network"
  done
  verify_production_separation
  verify_existing_lab_runtime_isolation
}

compose() {
  docker compose --project-name "$LAB_PROJECT" --project-directory "$LAB_DIR" --file "$COMPOSE_FILE" "$@"
}

prepare_operation() {
  local lock_mode="${1:-exclusive}"
  require_root
  require_command realpath
  require_command stat
  require_command flock
  acquire_lock "$lock_mode"
  require_command docker
  require_command awk
  require_command df
  require_command getconf
  require_command grep
  require_command hostname
  require_command paste
  require_command sed
  require_command tr
  require_trusted_package
  load_release_manifest
  validate_expected_host
  docker info >/dev/null 2>&1 || die 'The Docker daemon is unavailable.'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is unavailable.'
  compose config --quiet
  verify_lab_object_names
  verify_production_separation
  verify_existing_lab_runtime_isolation
}

container_health() {
  docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'missing'
}

wait_for_healthy() {
  local name="$1" description="$2" attempts="${3:-60}" status i
  for ((i = 1; i <= attempts; i++)); do
    status="$(container_health "$name")"
    if [[ "$status" == 'healthy' ]]; then
      return 0
    fi
    if [[ "$status" == 'unhealthy' || "$status" == 'exited' || "$status" == 'dead' ]]; then
      compose logs --tail 80 "$description" >&2 || true
      die "$description became $status."
    fi
    sleep 2
  done
  compose logs --tail 80 "$description" >&2 || true
  die "Timed out waiting for $description to become healthy."
}

verify_running_container_image() {
  local container="$1" expected_id="$2" actual_id
  actual_id="$(docker container inspect --format '{{.Image}}' "$container")"
  [[ "$actual_id" == "$expected_id" ]] || die "Running container image mismatch: $container"
}

verify_container_limits() {
  local container="$1" expected_memory="$2" expected_nano_cpus="$3" expected_pids="$4"
  local actual_memory actual_nano_cpus actual_pids restart_policy log_driver log_size log_files
  IFS=' ' read -r actual_memory actual_nano_cpus actual_pids restart_policy < <(
    docker container inspect --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.RestartPolicy.Name}}' "$container"
  )
  [[ "$actual_memory" == "$expected_memory" ]] || die "Unexpected memory limit on $container: $actual_memory"
  [[ "$actual_nano_cpus" == "$expected_nano_cpus" ]] || die "Unexpected CPU limit on $container: $actual_nano_cpus"
  [[ "$actual_pids" == "$expected_pids" ]] || die "Unexpected PID limit on $container: $actual_pids"
  [[ "$restart_policy" == 'no' ]] || die "Unexpected restart policy on $container: $restart_policy"
  IFS=' ' read -r log_driver log_size log_files < <(
    docker container inspect --format '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$container"
  )
  [[ "$log_driver" == 'json-file' && "$log_size" == '10m' && "$log_files" == '3' ]] \
    || die "Unexpected Docker logging limit on $container: $log_driver/$log_size/$log_files"
}

verify_lab_resource_limits() {
  verify_container_limits "$LAB_CONTAINER_DB" 1610612736 1000000000 256
  verify_container_limits "$LAB_CONTAINER_APP" 1073741824 1000000000 256
  verify_container_limits "$LAB_CONTAINER_INGRESS" 134217728 250000000 64
}

verify_lab_mongo_limits() {
  verify_container_limits "$LAB_CONTAINER_DB" 1610612736 1000000000 256
}

ensure_state_directories() {
  install -d -o root -g root -m 0700 "$STATE_DIR" "$LAB_BACKUP_ROOT"
}

lab_frontend_is_stopped() {
  local container running
  for container in "$LAB_CONTAINER_INGRESS" "$LAB_CONTAINER_APP"; do
    if docker container inspect "$container" >/dev/null 2>&1; then
      running="$(docker container inspect --format '{{.State.Running}}' "$container")" || return 1
      [[ "$running" == 'false' ]] || return 1
    fi
  done
}

stop_and_verify_lab_frontend() {
  local stop_rc=0
  compose stop ingress titra >/dev/null 2>&1 || stop_rc=$?
  lab_frontend_is_stopped || return 1
  [[ "$stop_rc" == '0' ]]
}

require_lab_frontend_stopped() {
  stop_and_verify_lab_frontend \
    || die 'Could not stop and verify both lab ingress and app; refusing to access or replace the lab database.'
}

restore_unsafe_marker_exists() {
  [[ -e "$RESTORE_UNSAFE_MARKER" || -L "$RESTORE_UNSAFE_MARKER" ]]
}

require_lab_safe_to_start() {
  if restore_unsafe_marker_exists; then
    die "Lab app start is blocked by $RESTORE_UNSAFE_MARKER. Re-run lab-restore.sh successfully before starting or switching the lab app."
  fi
}

mark_restore_unsafe() {
  local source_backup="$1" source_hash="$2" partial
  if restore_unsafe_marker_exists; then
    require_secure_root_file "$RESTORE_UNSAFE_MARKER"
    info "A prior unsafe restore marker remains in force: $RESTORE_UNSAFE_MARKER" >&2
    return 0
  fi

  partial="$RESTORE_UNSAFE_MARKER.partial.$$"
  [[ ! -e "$partial" && ! -L "$partial" ]] || die "Unsafe-marker temporary path already exists: $partial"
  printf 'format_version=1\nmarked_at_utc=%s\nsource_backup=%s\nsource_archive_sha256=%s\nstatus=restore-in-progress-or-unverified\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$source_backup" "$source_hash" > "$partial"
  chmod 0600 -- "$partial"
  mv -- "$partial" "$RESTORE_UNSAFE_MARKER"
  require_secure_root_file "$RESTORE_UNSAFE_MARKER"
  info "Lab app start is now blocked by the durable restore marker: $RESTORE_UNSAFE_MARKER"
}

clear_restore_unsafe_marker() {
  restore_unsafe_marker_exists || die 'The restore safety marker disappeared unexpectedly.'
  require_secure_root_file "$RESTORE_UNSAFE_MARKER"
  rm -f -- "$RESTORE_UNSAFE_MARKER"
  if restore_unsafe_marker_exists; then
    die 'The restore safety marker could not be cleared.'
  fi
  return 0
}

require_lab_host_capacity() {
  local mem_available_kib swap_free_kib mem_available_bytes swap_free_bytes combined_available
  local minimum_ram_required combined_required cpu_count load_one load_five ignored
  local load_one_hundredths load_five_hundredths cpu_capacity required_one required_five

  [[ -r /proc/meminfo && -r /proc/loadavg ]] || die 'Linux memory/load capacity information is unavailable.'
  mem_available_kib="$(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo)"
  swap_free_kib="$(awk '$1 == "SwapFree:" { print $2 }' /proc/meminfo)"
  [[ "$mem_available_kib" =~ ^[0-9]+$ && "$swap_free_kib" =~ ^[0-9]+$ ]] || die 'Host RAM/swap capacity values are invalid.'
  mem_available_bytes=$((mem_available_kib * 1024))
  swap_free_bytes=$((swap_free_kib * 1024))
  combined_available=$((mem_available_bytes + swap_free_bytes))
  minimum_ram_required=$((PRODUCTION_MEMORY_HEADROOM_BYTES + LAB_MINIMUM_RAM_WORKING_BYTES))
  combined_required=$((PRODUCTION_MEMORY_HEADROOM_BYTES + LAB_MEMORY_LIMIT_BYTES))
  (( mem_available_bytes >= minimum_ram_required )) \
    || die "Insufficient available RAM for lab plus production headroom: $mem_available_bytes available; $minimum_ram_required required."
  (( combined_available >= combined_required )) \
    || die "Insufficient available RAM+swap for bounded lab limits and production headroom: $combined_available available; $combined_required required."

  cpu_count="$(getconf _NPROCESSORS_ONLN)"
  [[ "$cpu_count" =~ ^[0-9]+$ && "$cpu_count" -ge 4 ]] || die 'At least four online CPUs are required for an isolated lab rehearsal.'
  IFS=' ' read -r load_one load_five ignored < /proc/loadavg
  load_one_hundredths="$(LC_ALL=C awk -v value="$load_one" 'BEGIN { printf "%d", (value * 100) + 0.5 }')"
  load_five_hundredths="$(LC_ALL=C awk -v value="$load_five" 'BEGIN { printf "%d", (value * 100) + 0.5 }')"
  [[ "$load_one_hundredths" =~ ^[0-9]+$ && "$load_five_hundredths" =~ ^[0-9]+$ ]] || die 'Host load averages are invalid.'
  cpu_capacity=$((cpu_count * 100))
  required_one=$((load_one_hundredths + LAB_CPU_LIMIT_HUNDREDTHS + PRODUCTION_CPU_HEADROOM_HUNDREDTHS))
  required_five=$((load_five_hundredths + LAB_CPU_LIMIT_HUNDREDTHS + PRODUCTION_CPU_HEADROOM_HUNDREDTHS))
  (( required_one <= cpu_capacity && required_five <= cpu_capacity )) \
    || die "Host load leaves insufficient CPU capacity for the capped lab plus one production CPU (load 1m/5m: $load_one/$load_five; CPUs: $cpu_count)."

  info "Host capacity gate passed: RAM=$mem_available_bytes, swap=$swap_free_bytes, CPUs=$cpu_count, load=$load_one/$load_five."
}

mongo_database_size_bytes() {
  local container="$1" database="$2" bytes
  bytes="$(docker exec "$container" mongosh "$database" --quiet --eval \
    'const s=db.stats(); print(Math.ceil(Math.max((s.storageSize || 0) + (s.indexSize || 0), (s.dataSize || 0) + (s.indexSize || 0))));')" \
    || die "Unable to measure MongoDB capacity for $container/$database."
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "MongoDB returned an invalid database size for $container/$database: $bytes"
  printf '%s\n' "$bytes"
}

filesystem_available_bytes() {
  local path="$1" bytes
  bytes="$(df --output=avail -B1 -- "$path" | awk 'NR == 2 { print $1 }')"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "Unable to determine filesystem capacity for $path"
  printf '%s\n' "$bytes"
}

require_lab_disk_capacity() {
  local archive="${1:-}" recorded_source_bytes="${2:-0}"
  local docker_root docker_device backup_device docker_available backup_available
  local production_bytes lab_bytes archive_bytes expansion_estimate source_estimate
  local production_headroom docker_required snapshot_required combined_required

  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  [[ -d "$docker_root" ]] || die "Docker root directory is unavailable: $docker_root"
  docker_root="$(realpath -e -- "$docker_root")"
  production_bytes="$(mongo_database_size_bytes "$PRODUCTION_DB_CONTAINER" "$PRODUCTION_DATABASE")"
  lab_bytes=0
  if docker container inspect "$LAB_CONTAINER_DB" >/dev/null 2>&1 \
    && [[ "$(docker container inspect --format '{{.State.Running}}' "$LAB_CONTAINER_DB")" == 'true' ]]; then
    lab_bytes="$(mongo_database_size_bytes "$LAB_CONTAINER_DB" "$LAB_DATABASE")"
  fi

  archive_bytes=0
  if [[ -n "$archive" ]]; then
    [[ -f "$archive" && ! -L "$archive" ]] || die 'Capacity gate received an unsafe backup archive path.'
    archive_bytes="$(stat -Lc '%s' -- "$archive")"
    [[ "$archive_bytes" =~ ^[0-9]+$ && "$archive_bytes" -le 1125899906842624 ]] || die 'Backup archive size is invalid or unreasonably large.'
  fi
  [[ "$recorded_source_bytes" =~ ^[0-9]+$ && "$recorded_source_bytes" -le 1125899906842624 ]] \
    || die 'Recorded backup database size is invalid or unreasonably large.'

  expansion_estimate=$((archive_bytes * 8))
  source_estimate="$production_bytes"
  (( recorded_source_bytes > source_estimate )) && source_estimate="$recorded_source_bytes"
  (( expansion_estimate > source_estimate )) && source_estimate="$expansion_estimate"
  (( lab_bytes > source_estimate )) && source_estimate="$lab_bytes"
  (( source_estimate > 0 )) || source_estimate="$GIB_BYTES"

  production_headroom=$((production_bytes * 2))
  (( production_headroom < PRODUCTION_DISK_HEADROOM_MINIMUM_BYTES )) \
    && production_headroom="$PRODUCTION_DISK_HEADROOM_MINIMUM_BYTES"
  # Docker space covers the clone, a full-size migration-wizard backup, and conservative DB/index growth.
  docker_required=$((source_estimate * 3 + production_headroom))
  # Backup space covers an uncompressed-equivalent lab snapshot plus working/retention headroom.
  snapshot_required=$((source_estimate * 2 + GIB_BYTES))

  docker_device="$(stat -Lc '%d' -- "$docker_root")"
  backup_device="$(stat -Lc '%d' -- "$LAB_BACKUP_ROOT")"
  docker_available="$(filesystem_available_bytes "$docker_root")"
  backup_available="$(filesystem_available_bytes "$LAB_BACKUP_ROOT")"

  if [[ "$docker_device" == "$backup_device" ]]; then
    combined_required=$((docker_required + snapshot_required))
    (( docker_available >= combined_required )) \
      || die "Insufficient free space on the shared Docker/backup filesystem: $docker_available available; $combined_required required for clone, wizard backup, lab snapshot, and production headroom."
  else
    (( docker_available >= docker_required )) \
      || die "Insufficient Docker-root free space: $docker_available available; $docker_required required for clone, wizard backup, and production headroom."
    (( backup_available >= snapshot_required )) \
      || die "Insufficient lab-backup free space: $backup_available available; $snapshot_required required for the lab snapshot."
  fi

  info "Disk capacity gate passed: source estimate=$source_estimate, Docker required=$docker_required, snapshot required=$snapshot_required."
}

read_literal_env_file() {
  local file="$1" destination_name="$2" raw key value
  declare -n destination="$destination_name"
  local -A seen=()

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    [[ "$raw" =~ ^([a-z][a-z0-9_]*)=(.*)$ ]] || die "Malformed literal state/manifest line: $raw"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]+x}" ]] || die "Duplicate backup manifest key: $key"
    seen[$key]=1
    # destination is a nameref to an associative array supplied by the caller.
    # shellcheck disable=SC2004
    destination[$key]="$value"
  done < "$file"
}
