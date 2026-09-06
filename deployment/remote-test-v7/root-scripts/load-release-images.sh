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
require_root
acquire_shared_lock

readonly PACKAGE_CHECKSUMS="${INSTALL_ROOT}/SHA256SUMS"
readonly LOAD_CONFIRMATION="LOAD VERIFIED TITRA PREDECESSOR CANDIDATE AND MONGO RELEASE IMAGES ON ${EXPECTED_HOST_FQDN}"

usage() {
  cat <<EOF
Usage:
  $0 --dry-run
  $0 --confirm '${LOAD_CONFIRMATION}'

This loads the checksum-bound v6 intermediate, v7 candidate, and MongoDB
7.0.40 disposable-lab image from local archives. It never pulls, starts,
stops, recreates, retags, or removes a container and it does not access the
production database.
EOF
}

existing_image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

validate_image_store() {
  local driver status
  driver=$(docker info --format '{{.Driver}}')
  status=$(docker info --format '{{json .DriverStatus}}')
  if grep -F 'io.containerd.snapshotter.v1' <<< "$status" >/dev/null; then
    [[ $driver == overlayfs || $driver == overlay2 ]] ||
      die "Unsupported containerd image-store driver: ${driver:-unknown}."
  else
    [[ $driver == overlay2 ]] || die "Unsupported classic image-store driver: ${driver:-unknown}."
  fi
}

archive_expanded_bytes() {
  local archive=$1 compressed expanded
  compressed=$(stat -c '%s' -- "$archive")
  expanded=$(gzip --list -- "$archive" | awk 'NR == 2 {print $2}')
  [[ $compressed =~ ^[1-9][0-9]*$ && $expanded =~ ^[1-9][0-9]*$ && $expanded -ge $compressed ]] ||
    die "Unable to size image archive ${archive}."
  printf '%s\n' "$expanded"
}

write_load_state() {
  local target=$1 ref=$2 actual_id=$3 archive_relative=$4 state temporary
  state=$(target_loaded_state "$target")
  temporary="${state}.tmp.$$"
  {
    printf 'format_version=1\n'
    printf 'package_release_id=%s\n' "$(release_value PACKAGE_RELEASE_ID)"
    printf 'target_kind=%s\n' "$target"
    printf 'image_ref=%s\n' "$ref"
    printf 'actual_image_id=%s\n' "$actual_id"
    printf 'archive_sha256=%s\n' "$(package_checksum_for_path "$archive_relative")"
    printf 'loaded_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$temporary"
  chmod 0600 -- "$temporary"
  mv -- "$temporary" "$state"
  validate_loaded_target_state "$target" >/dev/null
}

validate_package() {
  require_secure_installation
  require_runtime_commands
  validate_host
  validate_image_store
  validate_release_manifest
  require_no_unfinished_v7_operations
  require_secure_regular_file "$PACKAGE_CHECKSUMS"
  (cd -- "$INSTALL_ROOT" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
    die 'Installed r7 package failed exhaustive checksum verification.'
  v6_ref=$(release_value V6_IMAGE)
  v6_archive_relative=$(release_value V6_IMAGE_ARCHIVE)
  v6_archive="${INSTALL_ROOT}/${v6_archive_relative}"
  v7_ref=$(release_value TITRA_TEST_IMAGE)
  v7_archive_relative=$(release_value TITRA_IMAGE_ARCHIVE)
  v7_archive="${INSTALL_ROOT}/${v7_archive_relative}"
  mongo_ref=$(release_value MONGO_TEST_IMAGE)
  mongo_archive_relative=$(release_value MONGO_IMAGE_ARCHIVE)
  mongo_archive="${INSTALL_ROOT}/${mongo_archive_relative}"
  for archive in "$v6_archive" "$v7_archive" "$mongo_archive"; do
    require_secure_regular_file "$archive"
    gzip --test -- "$archive"
  done
  v6_existing=$(existing_image_id "$v6_ref")
  v7_existing=$(existing_image_id "$v7_ref")
  mongo_existing=$(existing_image_id "$mongo_ref")
  [[ -z $v6_existing ]] || v6_image_id_is_allowed "$v6_existing" ||
    die 'Existing v6 tag is an unapproved image collision.'
  [[ -z $v7_existing ]] || v7_image_id_is_allowed "$v7_existing" ||
    die 'Existing v7 tag is an unapproved image collision.'
  [[ -z $mongo_existing ]] || mongo_image_id_is_allowed "$mongo_existing" ||
    die 'Existing MongoDB 7.0.40 tag is an unapproved image collision.'
  local additional=0 docker_root available total reserve required
  [[ -n $v6_existing ]] || additional=$((additional + 2 * $(archive_expanded_bytes "$v6_archive")))
  [[ -n $v7_existing ]] || additional=$((additional + 2 * $(archive_expanded_bytes "$v7_archive")))
  [[ -n $mongo_existing ]] || additional=$((additional + 2 * $(archive_expanded_bytes "$mongo_archive")))
  docker_root=$(docker info --format '{{.DockerRootDir}}')
  available=$(df --output=avail -B1 -- "$docker_root" | awk 'NR == 2 {print $1}')
  total=$(df --output=size -B1 -- "$docker_root" | awk 'NR == 2 {print $1}')
  reserve=$((total / 10)); (( reserve >= 2147483648 )) || reserve=2147483648
  (( reserve <= 10737418240 )) || reserve=10737418240
  required=$((additional + reserve))
  (( available >= required )) ||
    die "Insufficient Docker-root capacity: available=${available}, required=${required}."
}

dry_run=false
confirmation=''
while (( $# > 0 )); do
  case $1 in
    --dry-run) dry_run=true; shift ;;
    --confirm)
      (( $# >= 2 )) || die '--confirm requires a value.'
      confirmation=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown image-load argument.' ;;
  esac
done

validate_package
if [[ $dry_run == true ]]; then
  [[ -z $confirmation ]] || die '--confirm cannot be combined with --dry-run.'
  printf 'All local image archives and release identities passed verification.\n'
  printf '  v6: %s (%s)\n' "$v6_ref" "${v6_existing:-not loaded}"
  printf '  v7: %s (%s)\n' "$v7_ref" "${v7_existing:-not loaded}"
  printf '  MongoDB lab: %s (%s)\n' "$mongo_ref" "${mongo_existing:-not loaded}"
  printf 'Required confirmation: %s\n' "$LOAD_CONFIRMATION"
  exit 0
fi
[[ $confirmation == "$LOAD_CONFIRMATION" ]] ||
  die 'Confirmation mismatch. Run --dry-run and copy its exact phrase.'

acquire_exclusive_lock
validate_package
if [[ -z $v6_existing ]]; then docker image load --input "$v6_archive" >/dev/null; fi
v6_actual=$(existing_image_id "$v6_ref")
v6_image_id_is_allowed "$v6_actual" || die 'Loaded v6 image ID is outside the exact release allowlist.'
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$v6_ref") == 'linux/amd64' ]] ||
  die 'Loaded v6 image is not linux/amd64.'
write_load_state v6 "$v6_ref" "$v6_actual" "$v6_archive_relative"

if [[ -z $v7_existing ]]; then docker image load --input "$v7_archive" >/dev/null; fi
v7_actual=$(existing_image_id "$v7_ref")
v7_image_id_is_allowed "$v7_actual" || die 'Loaded v7 image ID is outside the exact release allowlist.'
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$v7_ref") == 'linux/amd64' ]] ||
  die 'Loaded v7 image is not linux/amd64.'
write_load_state v7 "$v7_ref" "$v7_actual" "$v7_archive_relative"

if [[ -z $mongo_existing ]]; then docker image load --input "$mongo_archive" >/dev/null; fi
mongo_actual=$(existing_image_id "$mongo_ref")
mongo_image_id_is_allowed "$mongo_actual" || die 'Loaded MongoDB image ID differs from the exact release pin.'
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$mongo_ref") == 'linux/amd64' ]] ||
  die 'Loaded MongoDB lab image is not linux/amd64.'
write_load_state mongo "$mongo_ref" "$mongo_actual" "$mongo_archive_relative"

printf 'Loaded and receipt-bound all local release images; no container or database changed.\n'
printf '  v6 actual image ID: %s\n' "$v6_actual"
printf '  v7 actual image ID: %s\n' "$v7_actual"
printf '  MongoDB lab actual image ID: %s\n' "$mongo_actual"
