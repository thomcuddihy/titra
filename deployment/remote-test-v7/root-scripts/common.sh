#!/bin/bash

# Shared safety primitives for the root-operated Titra rehearsal tools.
# This file is sourced by the executable scripts in this directory.

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
umask 077

unset CDPATH ENV BASH_ENV COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
unset COMPOSE_ENV_FILES COMPOSE_PROFILES DOCKER_CONTEXT
export DOCKER_HOST='unix:///var/run/docker.sock'

readonly EXPECTED_HOST_FQDN='__V7_EXPECTED_HOST_FQDN__'
readonly LIVE_PROD_COMPOSE_FILE='__V7_PROD_COMPOSE_FILE__'
readonly EXPECTED_PROD_COMPOSE_SHA256='__V7_PROD_COMPOSE_SHA256__'
readonly EXPECTED_PROD_COMPOSE_BYTES='__V7_PROD_COMPOSE_BYTES__'
readonly PROD_PROJECT='__V7_PROD_PROJECT__'
readonly APP_SERVICE='__V7_APP_SERVICE__'
readonly DB_SERVICE='__V7_DB_SERVICE__'
readonly APP_CONTAINER='__V7_APP_CONTAINER__'
readonly DB_CONTAINER='__V7_DB_CONTAINER__'
readonly PROD_DATABASE='__V7_PROD_DATABASE__'

readonly INSTALL_ROOT='__V7_INSTALL_ROOT__'
readonly SCRIPT_ROOT="${INSTALL_ROOT}/root-scripts"
readonly RELEASE_MANIFEST="${INSTALL_ROOT}/manifest/release.env"
readonly STATE_ROOT='__V7_STATE_ROOT__'
readonly TRUSTED_PROD_COMPOSE_DIR="${STATE_ROOT}/production-compose"
readonly PROD_COMPOSE_FILE="${TRUSTED_PROD_COMPOSE_DIR}/docker-compose.yml"
readonly PROD_COMPOSE_ENV_FILE="${TRUSTED_PROD_COMPOSE_DIR}/empty.env"
readonly IMAGE_STATE_DIR="${STATE_ROOT}/production-images"
readonly DEPLOYMENT_RUN_ROOT="${STATE_ROOT}/production-deployments-v7"
readonly ROLLBACK_RUN_ROOT="${STATE_ROOT}/production-rollbacks-v7"
readonly DEPLOYMENT_LOG_ROOT="${STATE_ROOT}/logs-v7"
readonly V7_RUNTIME_CONFIG="${STATE_ROOT}/v7-runtime.env"
readonly V7_SOURCE_ARCHIVE_ROOT='__V7_BACKUP_ROOT__/v7-source-images'
readonly BASELINE_STATE="${STATE_ROOT}/production-baseline.env"
readonly ACTIVE_OVERRIDE="${IMAGE_STATE_DIR}/active-image.override.yml"
readonly RESTORE_AUTHORIZATION="${STATE_ROOT}/production-restore.authorization"
readonly BACKUP_ROOT='__V7_BACKUP_ROOT__/production'
readonly PRE_RESTORE_BACKUP_ROOT='__V7_BACKUP_ROOT__/pre-restore'
readonly IMAGE_BACKUP_ROOT='__V7_BACKUP_ROOT__/images'
readonly BASELINE_ARCHIVE_STATE="${STATE_ROOT}/production-baseline-archive.env"
readonly LOCK_DIR='__V7_LOCK_DIR__'
readonly LOCK_FILE="${LOCK_DIR}/operator.lock"

readonly BACKUP_FORMAT_VERSION='2'
readonly BACKUP_ARCHIVE='titra.archive.gz'
readonly BACKUP_CHECKSUM='titra.archive.gz.sha256'
readonly BACKUP_MANIFEST='manifest.env'

LOCK_FD=''
LOCK_INHERITED=false
MONGO_HEAVY_PREFIX=()
MONGO_HEAVY_MODE='normal-priority'
PROD_MONGO_VOLUME_NAME=''
PROD_MONGO_VOLUME_SOURCE=''
PROD_MONGO_VOLUME_LOGICAL_NAME=''

log() {
  printf '%s\n' "$*" >&2
}

warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || die 'This operation must be run as root.'
}

mode_is_not_group_or_world_writable() {
  local mode=$1
  (( (8#${mode} & 8#022) == 0 ))
}

require_root_owned_path_chain() {
  local input=$1
  local resolved owner mode

  resolved=$(readlink -f -- "$input") || die "Cannot resolve path: ${input}"
  [[ -e $resolved ]] || die "Required path does not exist: ${resolved}"

  while :; do
    owner=$(stat -c '%u' -- "$resolved") || die "Cannot inspect owner: ${resolved}"
    mode=$(stat -c '%a' -- "$resolved") || die "Cannot inspect mode: ${resolved}"
    [[ $owner == '0' ]] || die "Path is not root-owned: ${resolved}"
    mode_is_not_group_or_world_writable "$mode" ||
      die "Path is group- or world-writable: ${resolved}"
    [[ $resolved == '/' ]] && break
    resolved=$(dirname -- "$resolved")
  done
}

require_secure_regular_file() {
  local path=$1
  [[ -f $path && ! -L $path ]] || die "Expected a non-symlink regular file: ${path}"
  require_root_owned_path_chain "$path"
}

require_secure_directory() {
  local path=$1
  [[ -d $path && ! -L $path ]] || die "Expected a non-symlink directory: ${path}"
  require_root_owned_path_chain "$path"
}

require_secure_installation() {
  local caller_dir common_file
  common_file=$(readlink -f -- "${BASH_SOURCE[0]}") || die 'Cannot resolve common library path.'
  caller_dir=$(dirname -- "$common_file")
  [[ $caller_dir == "$SCRIPT_ROOT" ]] ||
    die "Refusing to run outside the installed root-owned directory ${SCRIPT_ROOT}."
  require_secure_regular_file "$common_file"
  require_secure_directory "$SCRIPT_ROOT"
}

require_command() {
  command -v -- "$1" >/dev/null 2>&1 || die "Required command not found in the safe PATH: $1"
}

require_runtime_commands() {
  local command_name
  for command_name in docker flock hostname readlink stat sha256sum awk sed grep sort paste date df find gzip cmp install dd tr dirname basename od chmod chown cp mv rm mkdir mktemp sleep sync tee tail base64 openssl wc; do
    require_command "$command_name"
  done
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required.'
}

validate_compose_cli_capabilities() {
  local up_help compose_model option

  up_help=$(docker compose up --help 2>&1) ||
    die 'Unable to inspect Docker Compose up capabilities.'
  for option in '--pull' '--no-deps' '--force-recreate' '--detach' '--no-start'; do
    grep -Eq -- "(^|[[:space:],])${option}([=[:space:],]|$)" <<< "$up_help" ||
      die "Docker Compose is missing required 'up' option: ${option}"
  done

  # `config` parses and normalizes this in-memory model without creating an
  # image, container, volume, or network. The fixed project name and explicit
  # empty environment file isolate the probe from the caller's directory.
  compose_model=$(docker compose \
    --env-file /dev/null \
    --project-name titra-r7-capability-probe \
    --file - \
    config 2>&1 <<'COMPOSE_MODEL'
services:
  capability_probe:
    image: scratch
    pull_policy: never
COMPOSE_MODEL
  ) || die "Docker Compose does not accept the required 'pull_policy: never' model."
  grep -Eq -- '^[[:space:]]*pull_policy:[[:space:]]*never[[:space:]]*$' <<< "$compose_model" ||
    die "Docker Compose did not preserve the required 'pull_policy: never' policy."
}

canonical_hostname() {
  hostname --fqdn | tr '[:upper:]' '[:lower:]' | sed 's/[.]$//'
}

validate_host() {
  local actual
  actual=$(canonical_hostname) || die 'Unable to determine the host FQDN.'
  [[ $actual == "$EXPECTED_HOST_FQDN" ]] ||
    die "Wrong host. Expected ${EXPECTED_HOST_FQDN}; found ${actual}."
}

compose_prod() {
  docker compose \
    --env-file "$PROD_COMPOSE_ENV_FILE" \
    --project-name "$PROD_PROJECT" \
    --project-directory "$TRUSTED_PROD_COMPOSE_DIR" \
    --file "$PROD_COMPOSE_FILE" \
    "$@"
}

compose_prod_with_override() {
  local override=$1
  shift
  docker compose \
    --env-file "$PROD_COMPOSE_ENV_FILE" \
    --project-name "$PROD_PROJECT" \
    --project-directory "$TRUSTED_PROD_COMPOSE_DIR" \
    --file "$PROD_COMPOSE_FILE" \
    --file "$override" \
    "$@"
}

stable_live_compose_digest() {
  local before after owner mode size digest

  [[ -f $LIVE_PROD_COMPOSE_FILE && ! -L $LIVE_PROD_COMPOSE_FILE ]] ||
    die "Live production Compose path is not a direct regular file: ${LIVE_PROD_COMPOSE_FILE}"
  before=$(stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' -- "$LIVE_PROD_COMPOSE_FILE") ||
    die 'Cannot inspect the live production Compose file.'
  owner=$(stat -c '%u' -- "$LIVE_PROD_COMPOSE_FILE")
  mode=$(stat -c '%a' -- "$LIVE_PROD_COMPOSE_FILE")
  size=$(stat -c '%s' -- "$LIVE_PROD_COMPOSE_FILE")
  [[ $owner == '0' ]] || die 'Live production Compose file is not root-owned.'
  mode_is_not_group_or_world_writable "$mode" ||
    die 'Live production Compose file is group- or world-writable.'
  [[ $size == "$EXPECTED_PROD_COMPOSE_BYTES" ]] ||
    die "Live production Compose size changed. Expected ${EXPECTED_PROD_COMPOSE_BYTES}; found ${size}."
  digest=$(dd if="$LIVE_PROD_COMPOSE_FILE" iflag=nofollow,nonblock,count_bytes,fullblock \
    count=$((EXPECTED_PROD_COMPOSE_BYTES + 1)) status=none | sha256sum | awk '{print $1}') ||
    die 'Unable to read the live production Compose file without following symlinks.'
  after=$(stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' -- "$LIVE_PROD_COMPOSE_FILE") ||
    die 'Cannot re-inspect the live production Compose file.'
  [[ $before == "$after" ]] || die 'Live production Compose file changed while it was being checked.'
  [[ $digest == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
    die "Live production Compose checksum changed. Expected ${EXPECTED_PROD_COMPOSE_SHA256}; found ${digest}."
  printf '%s\n' "$digest"
}

validate_compose_definition() {
  local services compose_digest live_digest
  require_secure_directory "$TRUSTED_PROD_COMPOSE_DIR"
  require_secure_regular_file "$PROD_COMPOSE_FILE"
  require_secure_regular_file "$PROD_COMPOSE_ENV_FILE"
  [[ ! -s $PROD_COMPOSE_ENV_FILE ]] || die 'Trusted Compose environment file must be empty.'
  [[ $(stat -c '%s' -- "$PROD_COMPOSE_FILE") == "$EXPECTED_PROD_COMPOSE_BYTES" ]] ||
    die 'Trusted production Compose size changed.'
  compose_digest=$(sha256sum --binary "$PROD_COMPOSE_FILE" | awk '{ print $1 }')
  [[ $compose_digest == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
    die "Trusted production Compose checksum changed. Expected ${EXPECTED_PROD_COMPOSE_SHA256}; found ${compose_digest}."
  live_digest=$(stable_live_compose_digest)
  [[ $live_digest == "$compose_digest" ]] || die 'Trusted and live production Compose bytes disagree.'
  if grep -Eiq '^[[:space:]]*(build|env_file|extends|include|configs|secrets)[[:space:]]*:' "$PROD_COMPOSE_FILE" ||
    grep -Eq "(^|[[:space:]:=\"'])\.\.?/" "$PROD_COMPOSE_FILE" ||
    grep -Fq "\${" "$PROD_COMPOSE_FILE"; then
    die 'Trusted production Compose depends on build/include/env/config/secret, interpolation, or relative-path input.'
  fi
  services=$(compose_prod config --services | LC_ALL=C sort | paste -sd ',' -)
  [[ $services == 'mongodb,titra' ]] ||
    die "Unexpected production services. Expected exactly mongodb,titra; found ${services}."
}

container_value() {
  local container=$1
  local template=$2
  docker inspect --type container --format "$template" "$container"
}

validate_container_identity() {
  local container=$1
  local service=$2
  local project_label service_label

  docker container inspect "$container" >/dev/null 2>&1 ||
    die "Expected container does not exist: ${container}"
  project_label=$(container_value "$container" '{{ index .Config.Labels "com.docker.compose.project" }}')
  service_label=$(container_value "$container" '{{ index .Config.Labels "com.docker.compose.service" }}')
  [[ $project_label == "$PROD_PROJECT" ]] ||
    die "Container ${container} belongs to project ${project_label}, not ${PROD_PROJECT}."
  [[ $service_label == "$service" ]] ||
    die "Container ${container} is service ${service_label}, not ${service}."
}

validate_production_mongo_volume() {
  local mount_record mount_count mount_type mount_name mount_source mount_rw
  local volume_mountpoint volume_project volume_logical configured_volumes

  mount_record=$(container_value "$DB_CONTAINER" \
    '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{printf "%s\t%s\t%s\t%t\n" .Type .Name .Source .RW}}{{end}}{{end}}')
  mount_count=$(printf '%s\n' "$mount_record" | awk 'NF {n++} END {print n + 0}')
  [[ $mount_count == '1' ]] || die 'Production Mongo must have exactly one /data/db mount.'
  IFS=$'\t' read -r mount_type mount_name mount_source mount_rw <<< "$mount_record"
  [[ $mount_type == 'volume' && $mount_rw == 'true' && -n $mount_name && $mount_source == /* ]] ||
    die 'Production Mongo /data/db is not a writable named Docker volume.'
  validate_safe_token 'production Mongo volume name' "$mount_name"
  [[ -d $mount_source && ! -L $mount_source ]] ||
    die "Production Mongo volume mountpoint is unavailable or unsafe: ${mount_source}"
  docker volume inspect "$mount_name" >/dev/null 2>&1 ||
    die "Production Mongo volume is not inspectable: ${mount_name}"
  volume_mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$mount_name")
  volume_project=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$mount_name")
  volume_logical=$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$mount_name")
  [[ $volume_mountpoint == "$mount_source" ]] || die 'Mongo container and Docker volume mountpoints disagree.'
  [[ $volume_project == "$PROD_PROJECT" && -n $volume_logical ]] ||
    die 'Mongo data volume lacks the expected production Compose ownership labels.'
  configured_volumes=$(compose_prod config --volumes | LC_ALL=C sort)
  grep -Fx -- "$volume_logical" <<< "$configured_volumes" >/dev/null ||
    die "Mongo volume logical name ${volume_logical} is absent from trusted Compose."

  PROD_MONGO_VOLUME_NAME=$mount_name
  PROD_MONGO_VOLUME_SOURCE=$mount_source
  PROD_MONGO_VOLUME_LOGICAL_NAME=$volume_logical
}

validate_production_containers() {
  validate_container_identity "$APP_CONTAINER" "$APP_SERVICE"
  validate_container_identity "$DB_CONTAINER" "$DB_SERVICE"
  [[ $(container_value "$DB_CONTAINER" '{{.Name}}') == "/${DB_CONTAINER}" ]] ||
    die 'Mongo container name validation failed.'
  [[ $(container_value "$APP_CONTAINER" '{{.Name}}') == "/${APP_CONTAINER}" ]] ||
    die 'Titra container name validation failed.'
  [[ $(container_value "$DB_CONTAINER" '{{.State.Running}}') == 'true' ]] ||
    die 'Production Mongo container is not running.'
  validate_production_mongo_volume
}

validate_production_context() {
  require_root
  require_secure_installation
  require_runtime_commands
  validate_compose_cli_capabilities
  validate_host
  validate_compose_definition
  validate_production_containers
}

adopt_inherited_operator_lock() {
  local inherited_fd=${TITRA_OPERATOR_LOCK_FD:-}
  local descriptor_path descriptor_target lock_target descriptor_identity lock_identity

  [[ $inherited_fd =~ ^[1-9][0-9]*$ && $inherited_fd -ge 3 && $inherited_fd -le 1024 ]] ||
    die 'Inherited operator lock descriptor is invalid.'
  descriptor_path="/proc/${BASHPID}/fd/${inherited_fd}"
  [[ -e $descriptor_path ]] || die 'Inherited operator lock descriptor is closed.'
  validate_existing_operator_lock
  descriptor_target=$(readlink -f -- "$descriptor_path") ||
    die 'Cannot resolve inherited operator lock descriptor.'
  lock_target=$(readlink -f -- "$LOCK_FILE") || die 'Cannot resolve operator lock file.'
  [[ $descriptor_target == "$lock_target" ]] ||
    die 'Inherited operator lock descriptor targets the wrong file.'
  descriptor_identity=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- "$descriptor_path") ||
    die 'Cannot inspect inherited operator lock descriptor.'
  lock_identity=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- "$LOCK_FILE") ||
    die 'Cannot inspect operator lock identity.'
  [[ $descriptor_identity == "$lock_identity" && $lock_identity == *':0:0:600:1' ]] ||
    die 'Inherited operator lock descriptor identity is unsafe.'
  flock --exclusive --nonblock "$inherited_fd" ||
    die 'Inherited operator lock descriptor does not hold the exclusive lock.'
  exec {LOCK_FD}<&"$inherited_fd"
  LOCK_INHERITED=true
}

release_operator_lock() {
  if [[ -n $LOCK_FD ]]; then
    if [[ $LOCK_INHERITED != true ]]; then
      flock --unlock "$LOCK_FD" >/dev/null 2>&1 || true
    fi
    exec {LOCK_FD}>&-
    LOCK_FD=''
    LOCK_INHERITED=false
  fi
}

validate_existing_operator_lock() {
  require_secure_directory "$LOCK_DIR"
  [[ $(stat -c '%a' -- "$LOCK_DIR") == '700' ]] || die "Lock directory mode is not 0700: ${LOCK_DIR}"
  [[ -f $LOCK_FILE && ! -L $LOCK_FILE ]] || die "Lock path is not a direct regular file: ${LOCK_FILE}"
  require_secure_regular_file "$LOCK_FILE"
  [[ $(stat -c '%u:%g:%a:%h' -- "$LOCK_FILE") == '0:0:600:1' ]] ||
    die 'Operator lock must be root:root mode 0600 with one hard link.'
}

acquire_shared_lock() {
  if [[ -n ${TITRA_OPERATOR_LOCK_FD:-} ]]; then
    release_operator_lock
    adopt_inherited_operator_lock
    return 0
  fi
  validate_existing_operator_lock
  exec {LOCK_FD}<"$LOCK_FILE"
  flock --shared --nonblock "$LOCK_FD" ||
    die "A Titra operator mutation holds ${LOCK_FILE}."
}

acquire_exclusive_lock() {
  release_operator_lock
  if [[ -n ${TITRA_OPERATOR_LOCK_FD:-} ]]; then
    adopt_inherited_operator_lock
    return 0
  fi
  [[ -d /run && ! -L /run ]] || die '/run is unavailable or unsafe.'
  if [[ ! -e $LOCK_DIR ]]; then
    install -d -o root -g root -m 0700 -- "$LOCK_DIR"
  fi
  require_secure_directory "$LOCK_DIR"
  [[ $(stat -c '%a' -- "$LOCK_DIR") == '700' ]] || die "Lock directory mode is not 0700: ${LOCK_DIR}"
  if [[ ! -e $LOCK_FILE ]]; then
    (umask 077; : > "$LOCK_FILE")
  fi
  [[ -f $LOCK_FILE && ! -L $LOCK_FILE ]] || die "Lock path is not a direct regular file: ${LOCK_FILE}"
  chown root:root -- "$LOCK_FILE"
  chmod 0600 -- "$LOCK_FILE"
  validate_existing_operator_lock
  exec {LOCK_FD}<>"$LOCK_FILE"
  flock --exclusive --nonblock "$LOCK_FD" ||
    die "Another Titra operator task holds ${LOCK_FILE}."
}

container_is_running() {
  [[ $(container_value "$1" '{{.State.Running}}') == 'true' ]]
}

validate_safe_token() {
  local label=$1
  local value=$2
  [[ $value =~ ^[A-Za-z0-9][A-Za-z0-9_.:@/+\=-]{0,254}$ ]] ||
    die "Invalid ${label}: only a restricted, non-whitespace character set is accepted."
}

validate_backup_id() {
  local backup_id=$1
  [[ $backup_id =~ ^(prod|pre-restore)-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] ||
    die "Invalid backup ID: ${backup_id}"
}

manifest_value() {
  local manifest=$1
  local key=$2
  local count line

  [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Invalid manifest key requested: ${key}"
  count=$(grep -c -E "^${key}=" "$manifest" || true)
  [[ $count == '1' ]] || die "Manifest must contain exactly one ${key} entry."
  line=$(grep -E "^${key}=" "$manifest")
  printf '%s\n' "${line#*=}"
}

validate_release_manifest() {
  local actual_keys expected_keys
  local package_release_id release_profile titra_version titra_image titra_id titra_config_id titra_archive
  local mongo_image mongo_id mongo_config_id mongo_source_digest mongo_archive source_commit source_context_sha
  local evidence_directory evidence_sha
  local stock_image stock_id v5_image v5_id v6_image v6_id v6_config_id v6_archive

  require_secure_regular_file "$RELEASE_MANIFEST"
  [[ $(awk 'END { print NR + 0 }' "$RELEASE_MANIFEST") == '25' ]] ||
    die 'Release manifest must contain exactly twenty-five records.'
  actual_keys=$(awk -F= 'NF >= 2 { print $1 }' "$RELEASE_MANIFEST" | LC_ALL=C sort | paste -sd ',' -)
  expected_keys='MONGO_CONFIG_IMAGE_ID,MONGO_IMAGE_ARCHIVE,MONGO_SOURCE_DIGEST,MONGO_TEST_IMAGE,MONGO_TEST_IMAGE_ID,PACKAGE_RELEASE_ID,RELEASE_FORMAT,RELEASE_PROFILE,SOURCE_COMMIT,SOURCE_CONTEXT_SHA256,STOCK_IMAGE,STOCK_IMAGE_ID,TITRA_CONFIG_IMAGE_ID,TITRA_IMAGE_ARCHIVE,TITRA_IMAGE_EVIDENCE_DIRECTORY,TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256,TITRA_TEST_IMAGE,TITRA_TEST_IMAGE_ID,TITRA_VERSION,V5_IMAGE,V5_IMAGE_ID,V6_CONFIG_IMAGE_ID,V6_IMAGE,V6_IMAGE_ARCHIVE,V6_IMAGE_ID'
  [[ $actual_keys == "$expected_keys" ]] ||
    die 'Release manifest has missing, duplicate, or unknown keys.'
  [[ $(manifest_value "$RELEASE_MANIFEST" RELEASE_FORMAT) == '7' ]] ||
    die 'Unsupported release manifest format.'
  titra_version=$(manifest_value "$RELEASE_MANIFEST" TITRA_VERSION)
  [[ $titra_version =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] ||
    die 'Release manifest Titra version is invalid.'

  package_release_id=$(manifest_value "$RELEASE_MANIFEST" PACKAGE_RELEASE_ID)
  release_profile=$(manifest_value "$RELEASE_MANIFEST" RELEASE_PROFILE)
  titra_image=$(manifest_value "$RELEASE_MANIFEST" TITRA_TEST_IMAGE)
  titra_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_TEST_IMAGE_ID)
  titra_config_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_CONFIG_IMAGE_ID)
  titra_archive=$(manifest_value "$RELEASE_MANIFEST" TITRA_IMAGE_ARCHIVE)
  mongo_image=$(manifest_value "$RELEASE_MANIFEST" MONGO_TEST_IMAGE)
  mongo_id=$(manifest_value "$RELEASE_MANIFEST" MONGO_TEST_IMAGE_ID)
  mongo_config_id=$(manifest_value "$RELEASE_MANIFEST" MONGO_CONFIG_IMAGE_ID)
  mongo_source_digest=$(manifest_value "$RELEASE_MANIFEST" MONGO_SOURCE_DIGEST)
  mongo_archive=$(manifest_value "$RELEASE_MANIFEST" MONGO_IMAGE_ARCHIVE)
  source_commit=$(manifest_value "$RELEASE_MANIFEST" SOURCE_COMMIT)
  source_context_sha=$(manifest_value "$RELEASE_MANIFEST" SOURCE_CONTEXT_SHA256)
  evidence_directory=$(manifest_value "$RELEASE_MANIFEST" TITRA_IMAGE_EVIDENCE_DIRECTORY)
  evidence_sha=$(manifest_value "$RELEASE_MANIFEST" TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256)
  stock_image=$(manifest_value "$RELEASE_MANIFEST" STOCK_IMAGE)
  stock_id=$(manifest_value "$RELEASE_MANIFEST" STOCK_IMAGE_ID)
  v5_image=$(manifest_value "$RELEASE_MANIFEST" V5_IMAGE)
  v5_id=$(manifest_value "$RELEASE_MANIFEST" V5_IMAGE_ID)
  v6_image=$(manifest_value "$RELEASE_MANIFEST" V6_IMAGE)
  v6_id=$(manifest_value "$RELEASE_MANIFEST" V6_IMAGE_ID)
  v6_config_id=$(manifest_value "$RELEASE_MANIFEST" V6_CONFIG_IMAGE_ID)
  v6_archive=$(manifest_value "$RELEASE_MANIFEST" V6_IMAGE_ARCHIVE)
  [[ $package_release_id == '__V7_PACKAGE_RELEASE_ID__' ]] ||
    die 'Release manifest does not identify the reviewed maintenance-r7 package.'
  [[ $release_profile =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
    die 'Release manifest profile is invalid.'
  validate_safe_token 'package release ID' "$package_release_id"
  validate_safe_token 'release Titra image reference' "$titra_image"
  validate_safe_token 'release Mongo image reference' "$mongo_image"
  validate_safe_token 'stock Titra image reference' "$stock_image"
  validate_safe_token 'v5 Titra image reference' "$v5_image"
  validate_safe_token 'v6 Titra image reference' "$v6_image"
  [[ $titra_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Release Titra image ID is invalid.'
  [[ $titra_config_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Release Titra config image ID is invalid.'
  [[ $mongo_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Release Mongo image ID is invalid.'
  [[ $mongo_config_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Release Mongo config image ID is invalid.'
  local id archive
  for id in "$stock_id" "$v5_id" "$v6_id" "$v6_config_id"; do
    [[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Supported source Titra image ID is invalid.'
  done
  for archive in "$titra_archive" "$mongo_archive" "$v6_archive"; do
    [[ $archive =~ ^images/[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$ ]] ||
      die 'Release manifest contains an unsafe image archive path.'
  done
  [[ $mongo_source_digest =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die 'Release Mongo source digest is invalid.'
  [[ $source_commit =~ ^[0-9a-f]{40}$ ]] || die 'Release source commit is invalid.'
  [[ $source_context_sha =~ ^[0-9a-f]{64}$ ]] || die 'Release source-context digest is invalid.'
  [[ ${titra_image##*:} == "${titra_version}-${source_commit:0:12}-ctx${source_context_sha:0:12}-${release_profile}-amd64" ]] ||
    die 'Release Titra image tag differs from the manifest provenance and release profile.'
  [[ $evidence_directory == 'evidence/candidate-image' ]] ||
    die 'Release candidate evidence directory differs from the reviewed fixed path.'
  [[ $evidence_sha =~ ^[0-9a-f]{64}$ ]] ||
    die 'Release candidate evidence checksum-manifest digest is invalid.'
}

release_value() {
  validate_release_manifest
  manifest_value "$RELEASE_MANIFEST" "$1"
}

validate_image_id() {
  [[ $1 =~ ^sha256:[0-9a-f]{64}$ ]] || die "Invalid Docker image ID: $1"
}

release_candidate_image_id_is_allowed() {
  local image_id=$1 tested_id config_id
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  validate_release_manifest
  tested_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_TEST_IMAGE_ID)
  config_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_CONFIG_IMAGE_ID)
  [[ $image_id == "$tested_id" || $image_id == "$config_id" ]]
}

validate_release_candidate_image_id() {
  local image_id=$1
  validate_image_id "$image_id"
  release_candidate_image_id_is_allowed "$image_id" ||
    die "Candidate image ID ${image_id} is outside the exact release-bound tested/config allowlist."
}

release_candidate_image_id_allowlist() {
  local tested_id config_id
  validate_release_manifest
  tested_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_TEST_IMAGE_ID)
  config_id=$(manifest_value "$RELEASE_MANIFEST" TITRA_CONFIG_IMAGE_ID)
  if [[ $tested_id == "$config_id" ]]; then
    printf '%s\n' "$tested_id"
  else
    printf '%s,%s\n' "$tested_id" "$config_id"
  fi
}

package_checksum_for_path() {
  local relative_path=$1 checksum_file="${INSTALL_ROOT}/SHA256SUMS" count digest
  [[ $relative_path =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $relative_path != *'..'* ]] ||
    die 'Cannot look up an unsafe package checksum path.'
  require_secure_regular_file "$checksum_file"
  count=$(awk -v path="$relative_path" 'substr($0, 67) == path { count++ } END { print count + 0 }' "$checksum_file")
  [[ $count == '1' ]] || die "Package checksum manifest must contain exactly one ${relative_path} record."
  digest=$(awk -v path="$relative_path" 'substr($0, 67) == path { print $1 }' "$checksum_file")
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || die "Package checksum for ${relative_path} is invalid."
  printf '%s\n' "$digest"
}

validate_local_linux_amd64_image() {
  local image_ref=$1
  local image_id image_os image_arch
  validate_safe_token 'image reference' "$image_ref"
  docker image inspect "$image_ref" >/dev/null 2>&1 ||
    die "Image is not loaded locally: ${image_ref}"
  image_id=$(docker image inspect --format '{{.Id}}' "$image_ref")
  image_os=$(docker image inspect --format '{{.Os}}' "$image_ref")
  image_arch=$(docker image inspect --format '{{.Architecture}}' "$image_ref")
  validate_image_id "$image_id"
  [[ $image_os == 'linux' && $image_arch == 'amd64' ]] ||
    die "Image ${image_ref} is ${image_os}/${image_arch}, not linux/amd64."
  printf '%s\n' "$image_id"
}

validate_baseline_archive_state() {
  local keys image_id archive_path canonical_archive canonical_root archive_dir expected_digest actual_digest
  require_secure_regular_file "$BASELINE_ARCHIVE_STATE"
  keys=$(awk -F= '{print $1}' "$BASELINE_ARCHIVE_STATE" | paste -sd ',' -)
  [[ $keys == 'format_version,baseline_image_id,archive_path,archive_sha256,captured_at_utc' ]] ||
    die 'Production baseline archive state has unexpected or reordered keys.'
  [[ $(manifest_value "$BASELINE_ARCHIVE_STATE" format_version) == '1' ]] ||
    die 'Unsupported production baseline archive format.'
  image_id=$(manifest_value "$BASELINE_ARCHIVE_STATE" baseline_image_id)
  validate_image_id "$image_id"
  archive_path=$(manifest_value "$BASELINE_ARCHIVE_STATE" archive_path)
  require_secure_regular_file "$archive_path"
  canonical_root=$(readlink -f -- "$IMAGE_BACKUP_ROOT") || die 'Cannot resolve baseline image backup root.'
  canonical_archive=$(readlink -f -- "$archive_path") || die 'Cannot resolve baseline image archive.'
  [[ $archive_path == "$canonical_archive" ]] || die 'Baseline archive state must contain a canonical path.'
  archive_dir=$(dirname -- "$canonical_archive")
  [[ $(dirname -- "$archive_dir") == "$canonical_root" && \
    $(basename -- "$archive_dir") =~ ^production-baseline-[0-9a-f]{16}$ && \
    $(basename -- "$canonical_archive") == 'image.tar.gz' ]] ||
    die 'Production baseline archive escaped its dedicated one-level backup directory.'
  expected_digest=$(manifest_value "$BASELINE_ARCHIVE_STATE" archive_sha256)
  [[ $expected_digest =~ ^[0-9a-f]{64}$ ]] || die 'Baseline archive SHA-256 is invalid.'
  actual_digest=$(sha256sum --binary "$archive_path" | awk '{ print $1 }')
  [[ $actual_digest == "$expected_digest" ]] || die 'Baseline image archive checksum failed.'
  gzip --test -- "$archive_path" || die 'Baseline image archive gzip verification failed.'
}

validate_baseline_state() {
  local keys tag recorded_id actual_id archive_id
  require_secure_regular_file "$BASELINE_STATE"
  keys=$(awk -F= '{print $1}' "$BASELINE_STATE" | paste -sd ',' -)
  [[ $keys == 'format_version,baseline_image_tag,baseline_image_id,captured_at_utc' ]] ||
    die 'Production baseline state has unexpected or reordered keys.'
  [[ $(manifest_value "$BASELINE_STATE" format_version) == '1' ]] ||
    die 'Unsupported production baseline format.'
  tag=$(manifest_value "$BASELINE_STATE" baseline_image_tag)
  recorded_id=$(manifest_value "$BASELINE_STATE" baseline_image_id)
  validate_safe_token 'baseline image tag' "$tag"
  validate_image_id "$recorded_id"
  validate_baseline_archive_state
  archive_id=$(manifest_value "$BASELINE_ARCHIVE_STATE" baseline_image_id)
  [[ $archive_id == "$recorded_id" ]] || die 'Baseline state and archive state image IDs disagree.'
  actual_id=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
  [[ -z $actual_id || $actual_id == "$recorded_id" ]] ||
    die 'The immutable baseline tag resolves to the wrong image ID.'
}

capture_production_baseline() {
  local current_ref current_id stock_ref short_id baseline_tag captured_at image_size free required
  local partial final archive digest bundle_manifest state_temporary archive_state_temporary

  if [[ -e $BASELINE_STATE || -e $BASELINE_ARCHIVE_STATE ]]; then
    [[ -e $BASELINE_STATE && -e $BASELINE_ARCHIVE_STATE ]] ||
      die 'Production baseline state is incomplete; investigate rather than overwriting it.'
    validate_baseline_state
    return 0
  fi

  require_secure_directory "$IMAGE_BACKUP_ROOT"
  require_command gzip
  current_ref=$(container_value "$APP_CONTAINER" '{{.Config.Image}}')
  current_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  stock_ref=$(release_value STOCK_IMAGE)
  [[ $current_ref == "$stock_ref" ]] ||
    die "Cannot establish stock baseline: current image reference differs from the reviewed release manifest."
  validate_image_id "$current_id"
  short_id=${current_id#sha256:}
  short_id=${short_id:0:16}
  baseline_tag="titra-remote-test/production-baseline:${short_id}"

  image_size=$(docker image inspect --format '{{.Size}}' "$current_id")
  [[ $image_size =~ ^[0-9]+$ ]] || die 'Docker returned an invalid stock image size.'
  free=$(available_bytes "$IMAGE_BACKUP_ROOT")
  required=$((image_size * 2 + 536870912))
  (( free >= required )) ||
    die "Insufficient space for baseline image archive: ${free} bytes free; ${required} required."

  docker image tag "$current_id" "$baseline_tag"
  [[ $(docker image inspect --format '{{.Id}}' "$baseline_tag") == "$current_id" ]] ||
    die 'Failed to pin the production baseline image.'

  partial="${IMAGE_BACKUP_ROOT}/production-baseline-${short_id}.partial"
  final="${IMAGE_BACKUP_ROOT}/production-baseline-${short_id}"
  [[ ! -e $partial && ! -e $final ]] || die 'Baseline image archive destination already exists.'
  mkdir --mode=0700 -- "$partial"
  archive="${partial}/image.tar.gz"
  log "Saving exact stock image ${current_id} to a compressed root-only archive."
  docker image save "$baseline_tag" | gzip --best > "$archive"
  chmod 0600 -- "$archive"
  [[ -s $archive ]] || die 'Docker image save produced an empty baseline archive.'
  gzip --test -- "$archive" || die 'Baseline image archive gzip verification failed.'
  digest=$(sha256sum --binary "$archive" | awk '{ print $1 }')
  printf '%s  image.tar.gz\n' "$digest" > "${partial}/image.tar.gz.sha256"
  chmod 0600 -- "${partial}/image.tar.gz.sha256"
  captured_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  bundle_manifest="${partial}/manifest.env"
  {
    printf 'format_version=1\n'
    printf 'baseline_image_tag=%s\n' "$baseline_tag"
    printf 'baseline_image_id=%s\n' "$current_id"
    printf 'archive_file=image.tar.gz\n'
    printf 'archive_sha256=%s\n' "$digest"
    printf 'captured_at_utc=%s\n' "$captured_at"
  } > "$bundle_manifest"
  chmod 0600 -- "$bundle_manifest"
  (
    cd -- "$partial"
    sha256sum --check --strict image.tar.gz.sha256 >/dev/null
  ) || die 'Baseline image archive checksum failed before promotion.'
  mv -- "$partial" "$final"

  archive_state_temporary="${BASELINE_ARCHIVE_STATE}.tmp.$$"
  {
    printf 'format_version=1\n'
    printf 'baseline_image_id=%s\n' "$current_id"
    printf 'archive_path=%s/image.tar.gz\n' "$final"
    printf 'archive_sha256=%s\n' "$digest"
    printf 'captured_at_utc=%s\n' "$captured_at"
  } > "$archive_state_temporary"
  chmod 0600 -- "$archive_state_temporary"
  mv -- "$archive_state_temporary" "$BASELINE_ARCHIVE_STATE"

  state_temporary="${BASELINE_STATE}.tmp.$$"
  {
    printf 'format_version=1\n'
    printf 'baseline_image_tag=%s\n' "$baseline_tag"
    printf 'baseline_image_id=%s\n' "$current_id"
    printf 'captured_at_utc=%s\n' "$captured_at"
  } > "$state_temporary"
  chmod 0600 -- "$state_temporary"
  mv -- "$state_temporary" "$BASELINE_STATE"
  validate_baseline_state
  sync -f "$final"
  sync -f "$IMAGE_BACKUP_ROOT"
  sync -f "$BASELINE_STATE"
  sync -f "$STATE_ROOT"
  log "Captured immutable stock baseline and archive for ${current_id}."
}

ensure_baseline_image_loaded() {
  local tag recorded_id archive_path actual_id
  validate_baseline_state
  tag=$(manifest_value "$BASELINE_STATE" baseline_image_tag)
  recorded_id=$(manifest_value "$BASELINE_STATE" baseline_image_id)
  actual_id=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
  if [[ -z $actual_id ]]; then
    archive_path=$(manifest_value "$BASELINE_ARCHIVE_STATE" archive_path)
    log 'Baseline tag is absent; loading the checksum-verified local baseline archive (never pulling).'
    docker image load --input "$archive_path"
    actual_id=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
  fi
  [[ $actual_id == "$recorded_id" ]] || die 'Unable to recover the exact production baseline image.'
}

validate_backup_bundle() {
  local backup_id=$1
  local allowed_root=${2:-$BACKUP_ROOT}
  local bundle manifest archive checksum summary expected_digest actual_digest sidecar_name
  local expected_summary_digest actual_summary_digest numeric_value actual_keys expected_keys
  local summary_database summary_collection_count summary_document_count summary_index_count
  local backup_mongo_version current_mongo_version backup_mongo_major_minor current_mongo_major_minor
  local created_epoch completed_epoch

  validate_backup_id "$backup_id"
  require_secure_directory "$allowed_root"
  if [[ $(readlink -f -- "$allowed_root") == "$(readlink -f -- "$BACKUP_ROOT")" ]]; then
    [[ $backup_id == prod-* ]] || die 'Only prod-* bundles are valid under the production backup root.'
  elif [[ $(readlink -f -- "$allowed_root") == "$(readlink -f -- "$PRE_RESTORE_BACKUP_ROOT")" ]]; then
    [[ $backup_id == pre-restore-* ]] || die 'Only pre-restore-* bundles are valid under the safety-backup root.'
  else
    die 'Backup validation root is not an approved production or pre-restore root.'
  fi
  bundle="${allowed_root}/${backup_id}"
  require_secure_directory "$bundle"
  [[ $(dirname -- "$(readlink -f -- "$bundle")") == "$(readlink -f -- "$allowed_root")" ]] ||
    die 'Backup escaped the configured backup root.'

  manifest="${bundle}/${BACKUP_MANIFEST}"
  archive="${bundle}/${BACKUP_ARCHIVE}"
  checksum="${bundle}/${BACKUP_CHECKSUM}"
  summary="${bundle}/database-summary.json"
  require_secure_regular_file "$manifest"
  require_secure_regular_file "$archive"
  require_secure_regular_file "$checksum"
  require_secure_regular_file "$summary"

  expected_keys='format_version,backup_id,source_host,source_project,source_service,source_container,source_database,archive_format,archive_file,archive_sha256,app_quiesced,restore_dry_run,database_summary_file,database_summary_sha256,collection_count,document_count,index_count,database_total_size_bytes,created_utc,completed_utc,purpose,operator,change_ticket,production_compose_sha256,app_image_ref,app_image_id,app_container_id,mongo_container_id,mongo_image_id,mongo_server_version,mongo_tools_version'
  actual_keys=$(awk -F= '{print $1}' "$manifest" | paste -sd ',' -)
  [[ $actual_keys == "$expected_keys" ]] || die 'Backup manifest has missing, duplicate, reordered, or unknown keys.'
  [[ $(manifest_value "$manifest" format_version) == "$BACKUP_FORMAT_VERSION" ]] ||
    die 'Unsupported backup manifest version.'
  [[ $(manifest_value "$manifest" backup_id) == "$backup_id" ]] ||
    die 'Backup manifest ID does not match its directory name.'
  [[ $(manifest_value "$manifest" source_host) == "$EXPECTED_HOST_FQDN" ]] ||
    die 'Backup was created on another host.'
  [[ $(manifest_value "$manifest" source_project) == "$PROD_PROJECT" ]] ||
    die 'Backup was created from another Compose project.'
  [[ $(manifest_value "$manifest" source_service) == "$DB_SERVICE" ]] ||
    die 'Backup was created from another Mongo service.'
  [[ $(manifest_value "$manifest" source_container) == "$DB_CONTAINER" ]] ||
    die 'Backup was created from another Mongo container.'
  [[ $(manifest_value "$manifest" source_database) == "$PROD_DATABASE" ]] ||
    die 'Backup source database is not titra.'
  [[ $(manifest_value "$manifest" archive_format) == 'mongodump-archive-gzip' ]] ||
    die 'Unsupported backup archive format.'
  [[ $(manifest_value "$manifest" archive_file) == "$BACKUP_ARCHIVE" ]] ||
    die 'Manifest archive filename is invalid.'
  [[ $(manifest_value "$manifest" app_quiesced) == 'true' ]] ||
    die 'Backup was not recorded as application-quiesced.'
  [[ $(manifest_value "$manifest" restore_dry_run) == 'true' ]] ||
    die 'Backup did not record a successful mongorestore dry run.'
  [[ $(manifest_value "$manifest" database_summary_file) == 'database-summary.json' ]] ||
    die 'Backup database summary filename is invalid.'
  [[ $(manifest_value "$manifest" production_compose_sha256) == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
    die 'Backup was made against an unexpected production Compose definition.'

  expected_digest=$(manifest_value "$manifest" archive_sha256)
  [[ $expected_digest =~ ^[0-9a-f]{64}$ ]] || die 'Manifest SHA-256 is invalid.'
  IFS=' ' read -r actual_digest sidecar_name < "$checksum" || die 'Cannot read checksum sidecar.'
  [[ $actual_digest == "$expected_digest" ]] || die 'Manifest and checksum sidecar disagree.'
  [[ $sidecar_name == "$BACKUP_ARCHIVE" ]] ||
    die 'Checksum sidecar names an unexpected file.'
  (
    cd -- "$bundle"
    sha256sum --check --strict "$BACKUP_CHECKSUM" >/dev/null
  ) || die 'Backup archive checksum verification failed.'

  expected_summary_digest=$(manifest_value "$manifest" database_summary_sha256)
  [[ $expected_summary_digest =~ ^[0-9a-f]{64}$ ]] || die 'Database summary SHA-256 is invalid.'
  actual_summary_digest=$(sha256sum --binary "$summary" | awk '{ print $1 }')
  [[ $actual_summary_digest == "$expected_summary_digest" ]] ||
    die 'Database summary checksum verification failed.'
  summary_database=$(sed -nE 's/^\{"database":"([^"]+)","collectionCount":[0-9]+,"documentCount":[0-9]+,"indexCount":[0-9]+,"collections":\[.*\]\}$/\1/p' "$summary")
  summary_collection_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":([0-9]+),"documentCount":[0-9]+,"indexCount":[0-9]+,"collections":\[.*\]\}$/\1/p' "$summary")
  summary_document_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":[0-9]+,"documentCount":([0-9]+),"indexCount":[0-9]+,"collections":\[.*\]\}$/\1/p' "$summary")
  summary_index_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":[0-9]+,"documentCount":[0-9]+,"indexCount":([0-9]+),"collections":\[.*\]\}$/\1/p' "$summary")
  [[ $summary_database == "$PROD_DATABASE" && $summary_collection_count =~ ^[0-9]+$ && \
    $summary_document_count =~ ^[0-9]+$ && $summary_index_count =~ ^[0-9]+$ ]] ||
    die 'Database summary does not have the exact expected schema or database identity.'
  [[ $(manifest_value "$manifest" collection_count) == "$summary_collection_count" && \
    $(manifest_value "$manifest" document_count) == "$summary_document_count" && \
    $(manifest_value "$manifest" index_count) == "$summary_index_count" ]] ||
    die 'Backup manifest totals disagree with its checksummed database summary.'
  for numeric_value in collection_count document_count index_count database_total_size_bytes; do
    [[ $(manifest_value "$manifest" "$numeric_value") =~ ^[0-9]+$ ]] ||
      die "Backup manifest ${numeric_value} is invalid."
  done
  [[ $(manifest_value "$manifest" app_image_id) =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die 'Backup application image ID is invalid.'
  [[ $(manifest_value "$manifest" app_container_id) =~ ^[0-9a-f]{64}$ ]] ||
    die 'Backup application container ID is invalid.'
  [[ $(manifest_value "$manifest" mongo_container_id) =~ ^[0-9a-f]{64}$ ]] ||
    die 'Backup Mongo container ID is invalid.'
  [[ $(manifest_value "$manifest" mongo_image_id) =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die 'Backup Mongo image ID is invalid.'
  [[ -n $(manifest_value "$manifest" app_image_ref) ]] || die 'Backup application image ref is empty.'
  backup_mongo_version=$(manifest_value "$manifest" mongo_server_version)
  [[ $backup_mongo_version =~ ^[0-9]+\.[0-9]+([.][0-9A-Za-z_.+-]+)?$ ]] || die 'Backup Mongo server version is invalid.'
  current_mongo_version=$(docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval 'print(db.version())')
  [[ $current_mongo_version =~ ^[0-9]+\.[0-9]+([.][0-9A-Za-z_.+-]+)?$ ]] || die 'Current Mongo server version is invalid.'
  backup_mongo_major_minor=$(awk -F. '{print $1 "." $2}' <<< "$backup_mongo_version")
  current_mongo_major_minor=$(awk -F. '{print $1 "." $2}' <<< "$current_mongo_version")
  [[ $backup_mongo_major_minor == "$current_mongo_major_minor" ]] ||
    die "Backup Mongo version ${backup_mongo_version} is incompatible with current ${current_mongo_version}."
  [[ -n $(manifest_value "$manifest" mongo_tools_version) ]] || die 'Mongo tools version is empty.'
  created_epoch=$(date -u -d "$(manifest_value "$manifest" created_utc)" '+%s' 2>/dev/null) ||
    die 'Backup creation time is invalid.'
  completed_epoch=$(date -u -d "$(manifest_value "$manifest" completed_utc)" '+%s' 2>/dev/null) ||
    die 'Backup completion time is invalid.'
  (( completed_epoch >= created_epoch )) || die 'Backup completion precedes its creation time.'

  printf '%s\n' "$bundle"
}

validate_recent_backup_bundle() {
  local backup_id=$1
  local bundle completed_utc completed_epoch now age
  bundle=$(validate_backup_bundle "$backup_id" "$BACKUP_ROOT")
  completed_utc=$(manifest_value "${bundle}/${BACKUP_MANIFEST}" completed_utc)
  completed_epoch=$(date -u -d "$completed_utc" '+%s' 2>/dev/null) ||
    die 'Backup completion time is invalid.'
  now=$(date -u '+%s')
  age=$((now - completed_epoch))
  (( age >= -300 )) || die 'Backup completion time is unexpectedly in the future.'
  (( age <= 86400 )) || die 'Candidate switch requires a production backup completed within 24 hours.'
  printf '%s\n' "$bundle"
}

sanitize_manifest_value() {
  local value=$1
  value=${value//$'\n'/_}
  value=${value//$'\r'/_}
  value=${value//=/__}
  printf '%s' "$value"
}

random_hex_8() {
  require_command od
  od -An -N4 -tx1 /dev/urandom | tr -d ' \n'
}

available_bytes() {
  df --output=avail -B1 -- "$1" | awk 'NR == 2 { print $1 }'
}

mongo_storage_bytes() {
  local bytes
  bytes=$(docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval \
    'const s=db.stats(); print(Math.max(s.totalSize || 0, (s.storageSize || 0) + (s.indexSize || 0), s.dataSize || 0));') ||
    die 'Unable to query production Mongo database size.'
  [[ $bytes =~ ^[0-9]+$ ]] || die "Mongo returned an invalid size: ${bytes}"
  printf '%s\n' "$bytes"
}

conservative_dump_bytes() {
  local database_bytes=$1
  [[ $database_bytes =~ ^[0-9]+$ ]] || die 'Invalid database size for dump capacity calculation.'
  printf '%s\n' "$((database_bytes * 2 + 536870912))"
}

require_backup_capacity() {
  local root=$1
  local database_bytes available required
  database_bytes=$(mongo_storage_bytes)
  available=$(available_bytes "$root")
  required=$(conservative_dump_bytes "$database_bytes")
  (( available >= required )) ||
    die "Insufficient free space under ${root}: ${available} bytes free; ${required} required."
}

require_production_restore_capacity() {
  local target_bundle=$1
  local manifest target_bytes current_bytes available total reserve required effective

  [[ -n $PROD_MONGO_VOLUME_SOURCE ]] || validate_production_mongo_volume
  manifest="${target_bundle}/${BACKUP_MANIFEST}"
  target_bytes=$(manifest_value "$manifest" database_total_size_bytes)
  [[ $target_bytes =~ ^[0-9]+$ ]] || die 'Target backup total-size estimate is invalid.'
  current_bytes=$(mongo_storage_bytes)
  available=$(available_bytes "$PROD_MONGO_VOLUME_SOURCE")
  total=$(df --output=size -B1 -- "$PROD_MONGO_VOLUME_SOURCE" | awk 'NR == 2 {print $1}')
  [[ $available =~ ^[0-9]+$ && $total =~ ^[0-9]+$ ]] || die 'Cannot measure Mongo data filesystem capacity.'
  reserve=$((total / 10))
  (( reserve >= 2147483648 )) || reserve=2147483648
  (( reserve <= 10737418240 )) || reserve=10737418240
  required=$((target_bytes * 2 + 536870912 + reserve))
  effective=$((available + current_bytes))
  (( available >= reserve && effective >= required )) ||
    die "Insufficient Mongo-volume restore capacity: free=${available}, reclaimable-current=${current_bytes}, target-peak-plus-reserve=${required}."
  log "Mongo restore capacity passed: free=${available}, reclaimable-current=${current_bytes}, target-peak-plus-reserve=${required}."
}

detect_mongo_heavy_mode() {
  if docker exec "$DB_CONTAINER" sh -c \
    'command -v ionice >/dev/null 2>&1 && command -v nice >/dev/null 2>&1 && ionice -c 3 nice -n 10 true' \
    >/dev/null 2>&1; then
    printf 'ionice-idle+nice-10\n'
  elif docker exec "$DB_CONTAINER" sh -c \
    'command -v nice >/dev/null 2>&1 && nice -n 10 true' >/dev/null 2>&1; then
    printf 'nice-10\n'
  else
    printf 'normal-priority\n'
  fi
}

configure_mongo_heavy_priority() {
  MONGO_HEAVY_MODE=$(detect_mongo_heavy_mode)
  case $MONGO_HEAVY_MODE in
    ionice-idle+nice-10)
      MONGO_HEAVY_PREFIX=(ionice -c 3 nice -n 10)
      ;;
    nice-10)
      MONGO_HEAVY_PREFIX=(nice -n 10)
      ;;
    normal-priority)
      MONGO_HEAVY_PREFIX=()
      warn 'Mongo container lacks usable ionice/nice; dump/restore will run at normal priority.'
      ;;
    *)
      die "Unexpected Mongo heavy-operation priority mode: ${MONGO_HEAVY_MODE}"
      ;;
  esac
  log "Mongo dump/restore priority mode: ${MONGO_HEAVY_MODE}."
}

assert_exact_app_stopped() {
  local expected_container_id=$1
  local actual_container_id running status
  validate_container_identity "$APP_CONTAINER" "$APP_SERVICE"
  actual_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  running=$(container_value "$APP_CONTAINER" '{{.State.Running}}')
  status=$(container_value "$APP_CONTAINER" '{{.State.Status}}')
  [[ $actual_container_id == "$expected_container_id" ]] ||
    die 'The production Titra container was replaced during database work.'
  [[ $running == 'false' && ( $status == 'exited' || $status == 'created' ) ]] ||
    die "The exact production Titra container is not quiesced (running=${running}, status=${status})."
}

assert_exact_app_running() {
  local expected_container_id=$1
  local actual_container_id running status
  validate_container_identity "$APP_CONTAINER" "$APP_SERVICE"
  actual_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  running=$(container_value "$APP_CONTAINER" '{{.State.Running}}')
  status=$(container_value "$APP_CONTAINER" '{{.State.Status}}')
  [[ $actual_container_id == "$expected_container_id" ]] ||
    die 'The production Titra container was replaced during application startup.'
  [[ $running == 'true' && $status == 'running' ]] ||
    die "The exact production Titra container is not running (running=${running}, status=${status})."
}

stop_exact_app_if_running() {
  local expected_container_id=$1
  local actual_container_id running
  actual_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}' 2>/dev/null || true)
  [[ $actual_container_id == "$expected_container_id" ]] || {
    warn 'Refusing to stop a replacement Titra container whose identity is unknown.'
    return 1
  }
  running=$(container_value "$APP_CONTAINER" '{{.State.Running}}' 2>/dev/null || true)
  if [[ $running == 'true' ]]; then
    docker stop --time 30 "$APP_CONTAINER" >/dev/null || return 1
  fi
  [[ $(container_value "$APP_CONTAINER" '{{.State.Running}}' 2>/dev/null || true) == 'false' ]]
}

assert_mongo_identity() {
  local expected=$1
  local phase=$2
  [[ $(mongo_identity_snapshot) == "$expected" ]] ||
    die "Production Mongo container/volume/network identity changed ${phase}."
  [[ $(container_value "$DB_CONTAINER" '{{.State.Running}}') == 'true' ]] ||
    die "Production Mongo stopped ${phase}."
}

write_database_summary() {
  local destination=$1
  docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval '
    const normalizeIndex = i => ({
      name: i.name,
      key: i.key,
      v: i.v,
      unique: i.unique === true,
      sparse: i.sparse === true,
      hidden: i.hidden === true,
      expireAfterSeconds: i.expireAfterSeconds === undefined ? null : i.expireAfterSeconds,
      partialFilterExpression: i.partialFilterExpression === undefined ? null : i.partialFilterExpression,
      collation: i.collation === undefined ? null : i.collation
    });
    const names = db.getCollectionNames().sort();
    const rows = names.map(name => {
      const indexes = db.getCollection(name).getIndexes().map(normalizeIndex)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {name, documents: db.getCollection(name).countDocuments({}), indexCount: indexes.length, indexes};
    });
    const collectionCount = rows.length;
    const documentCount = rows.reduce((n, row) => n + row.documents, 0);
    const indexCount = rows.reduce((n, row) => n + row.indexCount, 0);
    print(JSON.stringify({database: db.getName(), collectionCount, documentCount, indexCount, collections: rows}));
  ' > "$destination"
  chmod 0600 -- "$destination"
  [[ -s $destination ]] || die 'Mongo database summary is empty.'
}

write_backup_manifest() {
  local manifest=$1
  local backup_id=$2
  local digest=$3
  local created_utc=$4
  local completed_utc=$5
  local purpose=$6
  local ticket=$7
  local summary_digest=$8
  local collection_count=$9
  local document_count=${10}
  local index_count=${11}
  local database_total_size_bytes=${12}
  local mongo_server_version=${13}
  local mongo_tools_version=${14}
  local mongo_container_id mongo_image_id operator_name app_image_ref app_image_id app_container_id

  mongo_container_id=$(container_value "$DB_CONTAINER" '{{.Id}}')
  mongo_image_id=$(container_value "$DB_CONTAINER" '{{.Image}}')
  app_image_ref=$(container_value "$APP_CONTAINER" '{{.Config.Image}}')
  app_image_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  app_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  operator_name=${SUDO_USER:-root}

  {
    printf 'format_version=%s\n' "$BACKUP_FORMAT_VERSION"
    printf 'backup_id=%s\n' "$backup_id"
    printf 'source_host=%s\n' "$EXPECTED_HOST_FQDN"
    printf 'source_project=%s\n' "$PROD_PROJECT"
    printf 'source_service=%s\n' "$DB_SERVICE"
    printf 'source_container=%s\n' "$DB_CONTAINER"
    printf 'source_database=%s\n' "$PROD_DATABASE"
    printf 'archive_format=mongodump-archive-gzip\n'
    printf 'archive_file=%s\n' "$BACKUP_ARCHIVE"
    printf 'archive_sha256=%s\n' "$digest"
    printf 'app_quiesced=true\n'
    printf 'restore_dry_run=true\n'
    printf 'database_summary_file=database-summary.json\n'
    printf 'database_summary_sha256=%s\n' "$summary_digest"
    printf 'collection_count=%s\n' "$collection_count"
    printf 'document_count=%s\n' "$document_count"
    printf 'index_count=%s\n' "$index_count"
    printf 'database_total_size_bytes=%s\n' "$database_total_size_bytes"
    printf 'created_utc=%s\n' "$created_utc"
    printf 'completed_utc=%s\n' "$completed_utc"
    printf 'purpose=%s\n' "$(sanitize_manifest_value "$purpose")"
    printf 'operator=%s\n' "$(sanitize_manifest_value "$operator_name")"
    printf 'change_ticket=%s\n' "$(sanitize_manifest_value "$ticket")"
    printf 'production_compose_sha256=%s\n' "$EXPECTED_PROD_COMPOSE_SHA256"
    printf 'app_image_ref=%s\n' "$(sanitize_manifest_value "$app_image_ref")"
    printf 'app_image_id=%s\n' "$app_image_id"
    printf 'app_container_id=%s\n' "$app_container_id"
    printf 'mongo_container_id=%s\n' "$mongo_container_id"
    printf 'mongo_image_id=%s\n' "$mongo_image_id"
    printf 'mongo_server_version=%s\n' "$(sanitize_manifest_value "$mongo_server_version")"
    printf 'mongo_tools_version=%s\n' "$(sanitize_manifest_value "$mongo_tools_version")"
  } > "$manifest"
  chmod 0600 -- "$manifest"
}

create_database_backup_bundle() {
  local destination_root=$1
  local prefix=$2
  local purpose=$3
  local ticket=$4
  local stamp nonce backup_id partial final archive checksum manifest
  local created_utc completed_utc digest summary post_dump_summary summary_digest
  local collection_count document_count index_count database_total_size_bytes mongo_server_version mongo_tools_version
  local expected_app_container_id expected_mongo_identity

  require_secure_directory "$destination_root"
  require_backup_capacity "$destination_root"
  [[ $prefix == 'prod' || $prefix == 'pre-restore' ]] || die 'Invalid backup prefix.'
  expected_app_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  expected_mongo_identity=$(mongo_identity_snapshot)
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'before backup summary'
  wait_for_no_active_timecard_writer_leases 330

  stamp=$(date -u '+%Y%m%dT%H%M%SZ')
  nonce=$(random_hex_8)
  backup_id="${prefix}-${stamp}-${nonce}"
  validate_backup_id "$backup_id"
  partial="${destination_root}/${backup_id}.partial"
  final="${destination_root}/${backup_id}"
  [[ ! -e $partial && ! -e $final ]] || die "Backup destination already exists: ${backup_id}"
  mkdir --mode=0700 -- "$partial"

  archive="${partial}/${BACKUP_ARCHIVE}"
  checksum="${partial}/${BACKUP_CHECKSUM}"
  manifest="${partial}/${BACKUP_MANIFEST}"
  summary="${partial}/database-summary.json"
  created_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  write_database_summary "$summary"
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'after backup summary'
  summary_digest=$(sha256sum --binary "$summary" | awk '{ print $1 }')
  collection_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":([0-9]+),.*/\1/p' "$summary")
  document_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":[0-9]+,"documentCount":([0-9]+),.*/\1/p' "$summary")
  index_count=$(sed -nE 's/^\{"database":"[^"]+","collectionCount":[0-9]+,"documentCount":[0-9]+,"indexCount":([0-9]+),.*/\1/p' "$summary")
  [[ $collection_count =~ ^[0-9]+$ && $document_count =~ ^[0-9]+$ && $index_count =~ ^[0-9]+$ ]] ||
    die 'Mongo collection/document/index summary is invalid.'
  database_total_size_bytes=$(mongo_storage_bytes)
  mongo_server_version=$(docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval 'print(db.version())')
  mongo_tools_version=$(docker exec "$DB_CONTAINER" mongodump --version | sed -n '1p')
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'immediately before mongodump'

  log "Writing quiesced Mongo archive to ${partial}."
  configure_mongo_heavy_priority
  docker exec "$DB_CONTAINER" "${MONGO_HEAVY_PREFIX[@]}" mongodump \
    --db "$PROD_DATABASE" \
    --archive \
    --gzip > "$archive"
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'after mongodump'
  chmod 0600 -- "$archive"
  [[ -s $archive ]] || die 'mongodump produced an empty archive.'

  log 'Running mongorestore --dryRun against the completed archive before promotion.'
  docker exec -i "$DB_CONTAINER" "${MONGO_HEAVY_PREFIX[@]}" mongorestore \
    --dryRun \
    --archive \
    --gzip \
    --nsInclude='titra.*' < "$archive" >/dev/null
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'after mongorestore dry run'
  post_dump_summary="${partial}/database-summary-after-dump.json"
  write_database_summary "$post_dump_summary"
  cmp --silent "$summary" "$post_dump_summary" ||
    die 'Database document/index summary changed while the quiesced dump was being created.'
  rm -f -- "$post_dump_summary"
  assert_exact_app_stopped "$expected_app_container_id"
  assert_mongo_identity "$expected_mongo_identity" 'after post-dump summary verification'

  digest=$(sha256sum --binary "$archive" | awk '{ print $1 }')
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || die 'Unable to calculate archive SHA-256.'
  printf '%s  %s\n' "$digest" "$BACKUP_ARCHIVE" > "$checksum"
  chmod 0600 -- "$checksum"
  completed_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  write_backup_manifest "$manifest" "$backup_id" "$digest" "$created_utc" "$completed_utc" \
    "$purpose" "$ticket" "$summary_digest" "$collection_count" "$document_count" "$index_count" \
    "$database_total_size_bytes" "$mongo_server_version" "$mongo_tools_version"

  (
    cd -- "$partial"
    sha256sum --check --strict "$BACKUP_CHECKSUM" >/dev/null
  ) || die 'Fresh backup failed its checksum verification.'

  mv -- "$partial" "$final"
  sync -f "$final"
  sync -f "$destination_root"
  log "Backup promoted atomically to ${final}."
  printf '%s\n' "$final"
}

mongo_identity_snapshot() {
  local container_id runtime mounts networks
  container_id=$(container_value "$DB_CONTAINER" '{{.Id}}')
  runtime=$(container_value "$DB_CONTAINER" '{{printf "%s\t%d" .State.StartedAt .RestartCount}}')
  mounts=$(container_value "$DB_CONTAINER" \
    '{{range .Mounts}}{{printf "%s\t%s\t%s\t%s\t%t\n" .Type .Name .Source .Destination .RW}}{{end}}' \
    | LC_ALL=C sort)
  networks=$(container_value "$DB_CONTAINER" \
    '{{range $name, $network := .NetworkSettings.Networks}}{{printf "%s\t%s\t%s\t%s\t" $name $network.NetworkID $network.EndpointID $network.IPAddress}}{{with index $network "GlobalIPv6Address"}}{{printf "%s" .}}{{end}}{{printf "\n"}}{{end}}' \
    | LC_ALL=C sort)
  [[ -n $mounts && -n $networks ]] || die 'Mongo identity snapshot is missing its mount or network attachment.'
  printf '%s\n%s\n%s\n%s\n' "$container_id" "$runtime" "$mounts" "$networks" \
    | sha256sum | awk '{ print $1 }'
}

active_timecard_writer_lease_count() {
  local count
  count=$(docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval '
    const lock = db.getCollection("timecardDateMigrationLocks")
      .findOne({_id: "timecard-date-migration"});
    const now = new Date();
    const writers = Array.isArray(lock?.activeWriters) ? lock.activeWriters : [];
    print(writers.filter((writer) => writer?.leaseUntil > now).length);
  ')
  [[ $count =~ ^[0-9]+$ ]] ||
    die "Timecard writer-lease query returned an invalid count: ${count}"
  printf '%s\n' "$count"
}

wait_for_no_active_timecard_writer_leases() {
  local timeout_seconds=${1:-330}
  local deadline count
  deadline=$((SECONDS + timeout_seconds))
  while :; do
    count=$(active_timecard_writer_lease_count)
    if (( count == 0 )); then
      return 0
    fi
    (( SECONDS < deadline )) ||
      die "${count} live timecard writer lease(s) remain after the application stopped."
    sleep 2
  done
}

wait_for_app() {
  local timeout_seconds=${1:-180}
  local deadline health state code
  deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    state=$(container_value "$APP_CONTAINER" '{{.State.Running}}' 2>/dev/null || true)
    if [[ $state == 'true' ]]; then
      health=$(container_value "$APP_CONTAINER" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)
      if [[ $health == 'healthy' ]]; then
        return 0
      fi
      if [[ $health == 'unhealthy' ]]; then
        return 1
      fi
      if command -v curl >/dev/null 2>&1; then
        code=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
          --connect-timeout 2 --max-time 5 'http://127.0.0.1:3000/' 2>/dev/null || true)
        if [[ $code =~ ^[1-4][0-9][0-9]$ ]]; then
          return 0
        fi
      fi
    fi
    sleep 2
  done
  return 1
}

stop_app_for_database_work() {
  container_is_running "$APP_CONTAINER" || die 'Titra must be running before this operation.'
  docker stop --time 60 "$APP_CONTAINER" >/dev/null
  if container_is_running "$APP_CONTAINER"; then
    die 'Titra did not stop.'
  fi
  return 0
}

start_existing_app_container() {
  local expected_container_id=${1:-}
  if [[ -z $expected_container_id ]]; then
    expected_container_id=$(container_value "$APP_CONTAINER" '{{.Id}}')
  fi
  [[ $(container_value "$APP_CONTAINER" '{{.Id}}') == "$expected_container_id" ]] ||
    die 'Refusing to start a replacement Titra container.'
  docker start "$APP_CONTAINER" >/dev/null
  if ! wait_for_app 180; then
    warn 'Titra failed readiness checks; stopping the exact failed-start container.'
    stop_exact_app_if_running "$expected_container_id" ||
      warn 'Unable to prove the failed-readiness Titra container is stopped.'
    return 1
  fi
  assert_exact_app_running "$expected_container_id"
}

drop_production_database() {
  docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval \
    'const result=db.dropDatabase(); if (!result.ok) { throw new Error(JSON.stringify(result)); }' >/dev/null
}

restore_archive_to_production() {
  local archive=$1
  configure_mongo_heavy_priority
  docker exec -i "$DB_CONTAINER" "${MONGO_HEAVY_PREFIX[@]}" mongorestore \
    --archive \
    --gzip \
    --stopOnError \
    --nsInclude='titra.*' < "$archive"
}
