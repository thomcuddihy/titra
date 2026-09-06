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

usage() {
  cat <<EOF
Usage: $0 --target v6|v7

Supported paths are exact stock->v7, v5->v6, v5->v7, and v6->v7. This
preflight is read-only and calculates current backup/source-image headroom.
EOF
}

target=''
while (( $# > 0 )); do
  case $1 in
    --target)
      (( $# >= 2 )) || die '--target requires v6 or v7.'
      target=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown production-preflight argument.' ;;
  esac
done
[[ $target == v6 || $target == v7 ]] || die '--target must be v6 or v7.'

validate_production_context
validate_release_manifest
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
require_secure_regular_file "${INSTALL_ROOT}/SHA256SUMS"
(cd -- "$INSTALL_ROOT" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
  die 'Installed r7 package failed exhaustive checksum verification.'
current_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
current_ref=$(container_value "$APP_CONTAINER" '{{.Config.Image}}')
validate_image_id "$current_id"
source_kind=$(supported_source_kind "$current_id") ||
  die "Production image ${current_id} is not an approved stock/v5/v6 source."
validate_transition "$source_kind" "$target"
target_id=$(validate_loaded_target_state "$target")
target_ref=$(target_image_ref "$target")
[[ $target_id != "$current_id" ]] || die 'Production already runs the selected target image.'
if [[ $target == v7 ]]; then validate_v7_runtime_config; fi

mongo_version=$(docker exec "$DB_CONTAINER" mongosh "$PROD_DATABASE" --quiet --eval 'print(db.version())')
[[ $mongo_version =~ ^7[.]0[.][0-9]+$ ]] ||
  die "Production MongoDB ${mongo_version} is outside the reviewed 7.0 compatibility line."
require_backup_capacity "$BACKUP_ROOT"
require_secure_directory "$V7_SOURCE_ARCHIVE_ROOT"

source_directory=$(source_archive_directory "$source_kind" "$current_id")
if [[ -e $source_directory ]]; then
  validate_preserved_source "$source_kind" "$current_id" >/dev/null
  source_archive_budget=0
else
  source_image_bytes=$(docker image inspect --format '{{.Size}}' "$current_id")
  [[ $source_image_bytes =~ ^[1-9][0-9]*$ ]] || die 'Cannot size the source application image.'
  source_archive_budget=$((source_image_bytes * 2))
fi
source_available=$(df --output=avail -B1 -- "$V7_SOURCE_ARCHIVE_ROOT" | awk 'NR == 2 {print $1}')
source_total=$(df --output=size -B1 -- "$V7_SOURCE_ARCHIVE_ROOT" | awk 'NR == 2 {print $1}')
source_reserve=$((source_total / 10)); (( source_reserve >= 2147483648 )) || source_reserve=2147483648
(( source_reserve <= 10737418240 )) || source_reserve=10737418240
(( source_available >= source_archive_budget + source_reserve )) ||
  die "Insufficient source-image archive headroom: available=${source_available}, required=$((source_archive_budget + source_reserve))."

mem_available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
[[ $mem_available_kb =~ ^[0-9]+$ && $mem_available_kb -ge 1048576 ]] ||
  die 'Less than 1 GiB RAM is available for the attended backup and switch.'
"${SCRIPT_DIR}/preflight-personal-task-suggestions.sh" --preview
if [[ $target == v7 ]]; then
  "${SCRIPT_DIR}/preflight-v7-data-compatibility.sh" --preview
fi
[[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$current_id" ]] ||
  die 'Production application image changed during preflight.'

printf 'R7 production preflight passed.\n'
printf '  approved path:       %s -> %s\n' "$source_kind" "$target"
printf '  source image:        %s / %s\n' "$current_ref" "$current_id"
printf '  target image:        %s / %s\n' "$target_ref" "$target_id"
printf '  Mongo compatibility: %s\n' "$mongo_version"
printf '  source archive bytes reserved: %s\n' "$source_archive_budget"
if [[ $target == v7 ]]; then
  printf '  OAuth sealing key:   configured and valid (value hidden)\n'
  hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
  printf '  private hosts:       %s\n' "${hosts:-<empty>}"
fi
