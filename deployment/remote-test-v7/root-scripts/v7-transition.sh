#!/bin/bash

# Source/target identity, runtime-secret, and rollback-image helpers for the
# multi-generation maintenance-r7 transition. This file is sourced only by
# root scripts installed beneath the configured maintenance package root.

readonly V6_LOADED_STATE="${IMAGE_STATE_DIR}/loaded-v6.env"
readonly V7_LOADED_STATE="${IMAGE_STATE_DIR}/loaded-v7.env"
readonly V7_MONGO_LOADED_STATE="${IMAGE_STATE_DIR}/loaded-mongo-v7.env"
readonly V7_ACTIVE_STATE="${IMAGE_STATE_DIR}/active-v7-transition.env"

v7_image_id_is_allowed() {
  release_candidate_image_id_is_allowed "$1"
}

v6_image_id_is_allowed() {
  local image_id=$1
  [[ $image_id == "$(release_value V6_IMAGE_ID)" ||
    $image_id == "$(release_value V6_CONFIG_IMAGE_ID)" ]]
}

mongo_image_id_is_allowed() {
  [[ $1 == "$(release_value MONGO_TEST_IMAGE_ID)" ||
    $1 == "$(release_value MONGO_CONFIG_IMAGE_ID)" ]]
}

supported_source_kind() {
  local image_id=$1
  if [[ $image_id == "$(release_value STOCK_IMAGE_ID)" ]]; then
    printf 'stock\n'
  elif [[ $image_id == "$(release_value V5_IMAGE_ID)" ]]; then
    printf 'v5\n'
  elif v6_image_id_is_allowed "$image_id"; then
    printf 'v6\n'
  else
    return 1
  fi
}

validate_transition() {
  local source_kind=$1 target_kind=$2
  case "${source_kind}:${target_kind}" in
    stock:v7|v5:v6|v5:v7|v6:v7) return 0 ;;
    *) die "Unsupported r7 transition ${source_kind}->${target_kind}." ;;
  esac
}

validate_no_unsafe_production_bootstrap_flags() {
  local environment merged
  if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
    environment=$(container_value "$APP_CONTAINER" '{{range .Config.Env}}{{println .}}{{end}}')
    [[ $(grep -Ec '^TITRA_ENABLE_(FIRST_USER_ADMIN|ADMIN_RECOVERY)=' <<< "$environment") == '0' ]] ||
      die 'Production container must omit temporary first-user/admin-recovery flags.'
  fi
  [[ $(grep -Ec 'TITRA_ENABLE_(FIRST_USER_ADMIN|ADMIN_RECOVERY)' "$PROD_COMPOSE_FILE") == '0' ]] ||
    die 'Pinned production Compose must omit temporary first-user/admin-recovery flags.'
  if [[ -e $ACTIVE_OVERRIDE || -L $ACTIVE_OVERRIDE ]]; then
    require_secure_regular_file "$ACTIVE_OVERRIDE"
    merged=$(compose_prod_with_override "$ACTIVE_OVERRIDE" config) ||
      die 'Unable to inspect the active production override.'
    [[ $(grep -Ec 'TITRA_ENABLE_(FIRST_USER_ADMIN|ADMIN_RECOVERY):' <<< "$merged") == '0' ]] ||
      die 'Active production override must omit temporary first-user/admin-recovery flags.'
  fi
}

validate_production_recovery_context() {
  require_root
  require_secure_installation
  require_runtime_commands
  validate_compose_cli_capabilities
  validate_host
  validate_compose_definition
  validate_container_identity "$DB_CONTAINER" "$DB_SERVICE"
  [[ $(container_value "$DB_CONTAINER" '{{.Name}}') == "/${DB_CONTAINER}" &&
    $(container_value "$DB_CONTAINER" '{{.State.Running}}') == 'true' ]] ||
    die 'Production Mongo identity/running-state validation failed.'
  validate_production_mongo_volume
  if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
    validate_container_identity "$APP_CONTAINER" "$APP_SERVICE"
    [[ $(container_value "$APP_CONTAINER" '{{.Name}}') == "/${APP_CONTAINER}" ]] ||
      die 'Titra container name validation failed.'
  fi
}

unfinished_v7_operation_count() {
  local root state_file count=0
  for root in "$DEPLOYMENT_RUN_ROOT" "$ROLLBACK_RUN_ROOT"; do
    require_secure_directory "$root"
    while IFS= read -r -d '' state_file; do
      require_secure_regular_file "$state_file"
      if grep -Fx 'status=IN_PROGRESS' "$state_file" >/dev/null; then
        count=$((count + 1))
      fi
    done < <(find "$root" -mindepth 2 -maxdepth 2 -name state.env -print0)
  done
  printf '%s\n' "$count"
}

unfinished_predecessor_operation_count() {
  local root state_file count=0
  for root in \
    "${STATE_ROOT}/production-deployments" \
    "${STATE_ROOT}/production-rollbacks" \
    "${STATE_ROOT}/production-deployments-v6" \
    "${STATE_ROOT}/production-rollbacks-v6"; do
    if [[ -e $root || -L $root ]]; then
      require_secure_directory "$root"
      while IFS= read -r -d '' state_file; do
        require_secure_regular_file "$state_file"
        if grep -Fx 'status=IN_PROGRESS' "$state_file" >/dev/null; then
          count=$((count + 1))
        fi
      done < <(find "$root" -mindepth 2 -maxdepth 2 -name state.env -print0)
    fi
  done
  printf '%s\n' "$count"
}

require_no_unfinished_v7_operations() {
  local count predecessor_count
  count=$(unfinished_v7_operation_count)
  (( count == 0 )) ||
    die "Found ${count} unfinished r7 operation(s); review root-only state/logs before any new action."
  predecessor_count=$(unfinished_predecessor_operation_count)
  (( predecessor_count == 0 )) ||
    die "Found ${predecessor_count} unfinished r5/r6 operation(s); review their root-only state/logs before an r7 action."
}

target_image_ref() {
  case $1 in
    v6) release_value V6_IMAGE ;;
    v7) release_value TITRA_TEST_IMAGE ;;
    mongo) release_value MONGO_TEST_IMAGE ;;
    *) die 'Image target must be v6, v7, or mongo.' ;;
  esac
}

target_loaded_state() {
  case $1 in
    v6) printf '%s\n' "$V6_LOADED_STATE" ;;
    v7) printf '%s\n' "$V7_LOADED_STATE" ;;
    mongo) printf '%s\n' "$V7_MONGO_LOADED_STATE" ;;
    *) die 'Image target must be v6, v7, or mongo.' ;;
  esac
}

target_image_id_is_allowed() {
  case $1 in
    v6) v6_image_id_is_allowed "$2" ;;
    v7) v7_image_id_is_allowed "$2" ;;
    mongo) mongo_image_id_is_allowed "$2" ;;
    *) return 1 ;;
  esac
}

validate_loaded_target_state() {
  local target_kind=$1 state keys package_release ref actual_id archive archive_sha expected_sha
  state=$(target_loaded_state "$target_kind")
  require_secure_regular_file "$state"
  keys=$(awk -F= '{print $1}' "$state" | paste -sd ',' -)
  [[ $keys == 'format_version,package_release_id,target_kind,image_ref,actual_image_id,archive_sha256,loaded_at_utc' ]] ||
    die "${target_kind} load state has an unexpected schema."
  package_release=$(release_value PACKAGE_RELEASE_ID)
  [[ $(manifest_value "$state" format_version) == '1' &&
    $(manifest_value "$state" package_release_id) == "$package_release" &&
    $(manifest_value "$state" target_kind) == "$target_kind" ]] ||
    die "${target_kind} load state belongs to another release or target."
  ref=$(manifest_value "$state" image_ref)
  [[ $ref == "$(target_image_ref "$target_kind")" ]] || die "${target_kind} load-state tag changed."
  actual_id=$(manifest_value "$state" actual_image_id)
  target_image_id_is_allowed "$target_kind" "$actual_id" ||
    die "${target_kind} load-state image ID is outside the release allowlist."
  case $target_kind in
    v6) archive=$(release_value V6_IMAGE_ARCHIVE) ;;
    v7) archive=$(release_value TITRA_IMAGE_ARCHIVE) ;;
    mongo) archive=$(release_value MONGO_IMAGE_ARCHIVE) ;;
    *) die 'Image load state has an invalid target.' ;;
  esac
  archive_sha=$(manifest_value "$state" archive_sha256)
  expected_sha=$(package_checksum_for_path "$archive")
  [[ $archive_sha == "$expected_sha" ]] || die "${target_kind} archive identity changed."
  [[ $(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true) == "$actual_id" ]] ||
    die "Loaded ${target_kind} tag differs from its protected receipt."
  [[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$ref") == 'linux/amd64' ]] ||
    die "Loaded ${target_kind} image is not linux/amd64."
  printf '%s\n' "$actual_id"
}

validate_private_integration_hosts() {
  local value=$1 entry
  local -a entries=()
  [[ ${#value} -le 8192 && $value != *$'\n'* && $value != *$'\r'* && $value != *$'\t'* ]] || return 1
  [[ -z $value ]] && return 0
  IFS=',' read -r -a entries <<< "$value"
  for entry in "${entries[@]}"; do
    [[ -n $entry && $entry == "${entry,,}" && $entry != *' '* &&
      $entry =~ ^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\]|[0-9a-f:]+)$ &&
      $entry != *'..'* && $entry != *'*'* ]] || return 1
  done
}

validate_v7_runtime_config() {
  local keys key decoded_bytes hosts created updated created_epoch updated_epoch
  require_secure_regular_file "$V7_RUNTIME_CONFIG"
  [[ $(stat -c '%u:%g:%a:%h' -- "$V7_RUNTIME_CONFIG") == '0:0:600:1' ]] ||
    die 'V7 runtime configuration must be root:root mode 0600 with one hard link.'
  keys=$(awk -F= '{print $1}' "$V7_RUNTIME_CONFIG" | paste -sd ',' -)
  [[ $keys == 'format_version,oauth_secret_key,private_integration_hosts,created_at_utc,updated_at_utc' ]] ||
    die 'V7 runtime configuration has an unexpected schema.'
  [[ $(manifest_value "$V7_RUNTIME_CONFIG" format_version) == '1' ]] ||
    die 'Unsupported v7 runtime configuration version.'
  key=$(manifest_value "$V7_RUNTIME_CONFIG" oauth_secret_key)
  [[ $key =~ ^[A-Za-z0-9+/]{22}==$ ]] || die 'TITRA_OAUTH_SECRET_KEY is not canonical 16-byte base64.'
  decoded_bytes=$(printf '%s' "$key" | base64 --decode 2>/dev/null | wc -c | awk '{print $1}')
  [[ $decoded_bytes == '16' ]] || die 'TITRA_OAUTH_SECRET_KEY does not decode to exactly 16 bytes.'
  hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
  validate_private_integration_hosts "$hosts" || die 'TITRA_PRIVATE_INTEGRATION_HOSTS is invalid.'
  created=$(manifest_value "$V7_RUNTIME_CONFIG" created_at_utc)
  updated=$(manifest_value "$V7_RUNTIME_CONFIG" updated_at_utc)
  [[ $created =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
    $updated =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    die 'V7 runtime configuration timestamps are invalid.'
  created_epoch=$(date -u -d "$created" '+%s' 2>/dev/null) || die 'V7 runtime creation time is invalid.'
  updated_epoch=$(date -u -d "$updated" '+%s' 2>/dev/null) || die 'V7 runtime update time is invalid.'
  (( updated_epoch >= created_epoch )) || die 'V7 runtime update time precedes its creation time.'
}

v7_runtime_fingerprint() {
  validate_v7_runtime_config
  sha256sum --binary "$V7_RUNTIME_CONFIG" | awk '{print $1}'
}

write_transition_override() {
  local destination=$1 image_ref=$2 target_kind=$3 temporary key hosts
  validate_safe_token 'image reference' "$image_ref"
  [[ $target_kind == 'v6' || $target_kind == 'v7' || $target_kind == 'source' ]] ||
    die 'Transition override target must be v6, v7, or source.'
  temporary="${destination}.tmp.$$"
  {
    printf 'services:\n'
    printf '  titra:\n'
    printf '    image: %s\n' "$image_ref"
    printf '    pull_policy: never\n'
    if [[ $target_kind == 'v6' || $target_kind == 'v7' ]]; then
      printf '    environment:\n'
      printf '      TITRA_FENCE_RECOVERY_MODE: single-instance\n'
    fi
    if [[ $target_kind == 'v7' ]]; then
      validate_v7_runtime_config
      key=$(manifest_value "$V7_RUNTIME_CONFIG" oauth_secret_key)
      hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
      printf '      TITRA_OAUTH_SECRET_KEY: "%s"\n' "$key"
      printf '      TITRA_PRIVATE_INTEGRATION_HOSTS: "%s"\n' "$hosts"
    fi
  } > "$temporary"
  chmod 0600 -- "$temporary"
  mv -- "$temporary" "$destination"
  sync -f "$destination"
  sync -f "$(dirname -- "$destination")"
}

validate_transition_override() {
  local override=$1 target_kind=$2 expected_ref=$3 services merged
  require_secure_regular_file "$override"
  services=$(compose_prod_with_override "$override" config --services | LC_ALL=C sort | paste -sd ',' -)
  [[ $services == 'mongodb,titra' ]] || die 'Transition override changes the production service set.'
  [[ $(awk '$1 == "image:" {print $2}' "$override") == "$expected_ref" ]] ||
    die 'Transition override image does not match the selected target.'
  merged=$(compose_prod_with_override "$override" config) || die 'Unable to render transition Compose override.'
  if [[ $target_kind == 'v7' ]]; then
    [[ $(grep -Fc 'TITRA_OAUTH_SECRET_KEY:' <<< "$merged") == '1' &&
      $(grep -Fc 'TITRA_PRIVATE_INTEGRATION_HOSTS:' <<< "$merged") == '1' &&
      $(grep -Fc 'TITRA_FENCE_RECOVERY_MODE:' <<< "$merged") == '1' ]] ||
      die 'Merged v7 environment is missing or duplicates a required security setting.'
  elif [[ $target_kind == 'v6' ]]; then
    [[ $(grep -Ec 'TITRA_(OAUTH_SECRET_KEY|PRIVATE_INTEGRATION_HOSTS):' <<< "$merged") == '0' &&
      $(grep -Fc 'TITRA_FENCE_RECOVERY_MODE:' <<< "$merged") == '1' ]] ||
      die 'V6 intermediate must use only the single-instance recovery gate.'
  else
    [[ $(grep -Ec 'TITRA_(OAUTH_SECRET_KEY|PRIVATE_INTEGRATION_HOSTS|FENCE_RECOVERY_MODE):' <<< "$merged") == '0' ]] ||
      die 'Stock/v5 source rollback override must omit v7-only security settings.'
  fi
  [[ $(grep -Ec 'TITRA_ENABLE_(FIRST_USER_ADMIN|ADMIN_RECOVERY):' <<< "$merged") == '0' ]] ||
    die 'Merged production config contains a forbidden temporary admin bootstrap/recovery flag.'
}

validate_running_target_environment() {
  local target_kind=$1 environment count expected_key expected_hosts
  environment=$(container_value "$APP_CONTAINER" '{{range .Config.Env}}{{println .}}{{end}}')
  if [[ $target_kind == 'v7' ]]; then
    for name in TITRA_OAUTH_SECRET_KEY TITRA_PRIVATE_INTEGRATION_HOSTS TITRA_FENCE_RECOVERY_MODE; do
      count=$(grep -c "^${name}=" <<< "$environment" || true)
      [[ $count == '1' ]] || die "Running v7 container lacks exactly one ${name}."
    done
    [[ $(sed -n 's/^TITRA_FENCE_RECOVERY_MODE=//p' <<< "$environment") == 'single-instance' ]] ||
      die 'Running v7 container has the wrong recovery mode.'
    expected_key=$(manifest_value "$V7_RUNTIME_CONFIG" oauth_secret_key)
    expected_hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
    [[ $(sed -n 's/^TITRA_OAUTH_SECRET_KEY=//p' <<< "$environment") == "$expected_key" &&
      $(sed -n 's/^TITRA_PRIVATE_INTEGRATION_HOSTS=//p' <<< "$environment") == "$expected_hosts" ]] ||
      die 'Running v7 container does not exactly match the protected runtime configuration.'
  elif [[ $target_kind == 'v6' ]]; then
    [[ $(grep -Ec '^TITRA_(OAUTH_SECRET_KEY|PRIVATE_INTEGRATION_HOSTS)=' <<< "$environment") == '0' &&
      $(grep -c '^TITRA_FENCE_RECOVERY_MODE=single-instance$' <<< "$environment") == '1' ]] ||
      die 'Running v6 intermediate has an invalid recovery/security environment.'
  else
    [[ $(grep -Ec '^TITRA_(OAUTH_SECRET_KEY|PRIVATE_INTEGRATION_HOSTS|FENCE_RECOVERY_MODE)=' <<< "$environment") == '0' ]] ||
      die 'Non-v7 container unexpectedly contains v7-only security settings.'
  fi
}

source_archive_directory() {
  local source_kind=$1 source_id=$2
  printf '%s/%s-%s\n' "$V7_SOURCE_ARCHIVE_ROOT" "$source_kind" "${source_id#sha256:}"
}

validate_preserved_source() {
  local source_kind=$1 source_id=$2 directory state archive checksum keys tag
  [[ $source_kind == stock || $source_kind == v5 || $source_kind == v6 ]] ||
    die 'Preserved source kind is invalid.'
  validate_image_id "$source_id"
  directory=$(source_archive_directory "$source_kind" "$source_id")
  state="${directory}/source.env"
  archive="${directory}/source-image.tar.gz"
  checksum="${archive}.sha256"
  require_secure_directory "$directory"
  require_secure_regular_file "$state"
  require_secure_regular_file "$archive"
  require_secure_regular_file "$checksum"
  keys=$(awk -F= '{print $1}' "$state" | paste -sd ',' -)
  [[ $keys == 'format_version,source_kind,source_image_ref,source_image_id,rollback_tag,archive_sha256,captured_at_utc' ]] ||
    die 'Preserved source-image state has an unexpected schema.'
  [[ $(manifest_value "$state" format_version) == '1' &&
    $(manifest_value "$state" source_kind) == "$source_kind" &&
    $(manifest_value "$state" source_image_id) == "$source_id" ]] ||
    die 'Preserved source-image identity does not match this transition.'
  validate_safe_token 'preserved source image reference' "$(manifest_value "$state" source_image_ref)"
  [[ $(awk 'END {print NR + 0}' "$checksum") == '1' &&
    $(<"$checksum") == "$(manifest_value "$state" archive_sha256)  source-image.tar.gz" ]] ||
    die 'Preserved source-image checksum sidecar is malformed.'
  (cd -- "$directory" && sha256sum --check --strict 'source-image.tar.gz.sha256' >/dev/null) ||
    die 'Preserved source-image archive checksum failed.'
  tag=$(manifest_value "$state" rollback_tag)
  validate_safe_token 'preserved source rollback tag' "$tag"
  printf '%s\n' "$state"
}

preserve_source_image() {
  local source_kind=$1 source_ref=$2 source_id=$3 directory partial archive digest tag state
  [[ $source_kind == stock || $source_kind == v5 || $source_kind == v6 ]] ||
    die 'Source image kind is invalid.'
  validate_safe_token 'source image reference' "$source_ref"
  validate_image_id "$source_id"
  directory=$(source_archive_directory "$source_kind" "$source_id")
  if [[ -e $directory || -L $directory ]]; then
    validate_preserved_source "$source_kind" "$source_id"
    return
  fi
  partial="${directory}.partial.$$"
  [[ ! -e $partial ]] || die 'Source-image preservation temporary path already exists.'
  install -d -o root -g root -m 0700 -- "$partial"
  tag="local/titra-v7-rollback-${source_kind}:${source_id#sha256:}"
  docker image tag "$source_id" "$tag"
  [[ $(docker image inspect --format '{{.Id}}' "$tag") == "$source_id" ]] ||
    die 'Failed to establish the exact source rollback tag.'
  archive="${partial}/source-image.tar.gz"
  docker image save "$tag" | gzip --best > "$archive"
  [[ -s $archive ]] || die 'Source-image archive is empty.'
  gzip --test -- "$archive"
  digest=$(sha256sum --binary "$archive" | awk '{print $1}')
  printf '%s  source-image.tar.gz\n' "$digest" > "${archive}.sha256"
  state="${partial}/source.env"
  {
    printf 'format_version=1\n'
    printf 'source_kind=%s\n' "$source_kind"
    printf 'source_image_ref=%s\n' "$source_ref"
    printf 'source_image_id=%s\n' "$source_id"
    printf 'rollback_tag=%s\n' "$tag"
    printf 'archive_sha256=%s\n' "$digest"
    printf 'captured_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$state"
  chmod 0600 -- "$partial"/*
  mv -- "$partial" "$directory"
  validate_preserved_source "$source_kind" "$source_id"
  sync -f "$directory"
  sync -f "$V7_SOURCE_ARCHIVE_ROOT"
}

ensure_preserved_source_loaded() {
  local source_kind=$1 source_id=$2 state directory archive tag actual
  state=$(validate_preserved_source "$source_kind" "$source_id")
  directory=$(dirname -- "$state")
  archive="${directory}/source-image.tar.gz"
  tag=$(manifest_value "$state" rollback_tag)
  actual=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
  if [[ -z $actual ]]; then
    docker image load --input "$archive" >/dev/null
    actual=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null || true)
  fi
  [[ $actual == "$source_id" ]] || die 'Unable to recover exact preserved source image.'
  printf '%s\n' "$tag"
}
