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
Usage:
  $0 --show
  $0 --private-integration-hosts 'host1.example,host2.example' --dry-run
  $0 --private-integration-hosts 'host1.example,host2.example' --confirm 'EXACT PHRASE'

The OAuth encryption key is generated once by the package installer and is
never displayed or rotated here. Host entries are exact lowercase hostnames
without schemes, paths, ports, or wildcards. An empty value clears the list.
EOF
}

show=false
dry_run=false
hosts_set=false
hosts=''
confirmation=''
while (( $# > 0 )); do
  case $1 in
    --show) show=true; shift ;;
    --private-integration-hosts)
      (( $# >= 2 )) || die '--private-integration-hosts requires a value (which may be empty).'
      hosts=${2,,}
      hosts_set=true
      shift 2
      ;;
    --dry-run) dry_run=true; shift ;;
    --confirm)
      (( $# >= 2 )) || die '--confirm requires a value.'
      confirmation=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown v7 runtime-configuration argument.' ;;
  esac
done

validate_production_context
validate_release_manifest
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
validate_v7_runtime_config
if [[ $show == true ]]; then
  [[ $hosts_set == false && $dry_run == false && -z $confirmation ]] ||
    die '--show cannot be combined with an update option.'
  current_hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
  host_count=0
  [[ -z $current_hosts ]] || host_count=$(awk -F, '{print NF}' <<< "$current_hosts")
  printf 'V7 OAuth encryption key: configured and valid (value hidden)\n'
  printf 'Approved private integration hosts: %s\n' "$host_count"
  if [[ -n $current_hosts ]]; then
    printf '  %s\n' "$current_hosts"
  fi
  exit 0
fi

[[ $hosts_set == true ]] || die 'Choose --show or provide --private-integration-hosts.'
validate_private_integration_hosts "$hosts" ||
  die 'Private integration hosts must be a comma-separated list of exact lowercase hostnames/IP literals.'
current_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
if v7_image_id_is_allowed "$current_id"; then
  die 'Change private integration hosts only before v7 deployment; an active v7 container would require an attended recreate.'
fi
expected_confirmation="SET TITRA V7 PRIVATE INTEGRATION HOSTS TO ${hosts:-EMPTY} ON ${EXPECTED_HOST_FQDN}"
if [[ $dry_run == true ]]; then
  [[ -z $confirmation ]] || die '--confirm cannot be combined with --dry-run.'
  printf 'Runtime configuration preview passed. The persistent OAuth key will not change.\n'
  printf 'Private integration hosts: %s\n' "${hosts:-<empty>}"
  printf 'Required confirmation: %s\n' "$expected_confirmation"
  exit 0
fi
[[ $confirmation == "$expected_confirmation" ]] ||
  die 'Confirmation mismatch. Run --dry-run and copy its exact phrase.'

acquire_exclusive_lock
validate_no_unsafe_production_bootstrap_flags
require_no_unfinished_v7_operations
validate_v7_runtime_config
[[ $(container_value "$APP_CONTAINER" '{{.Image}}') == "$current_id" ]] ||
  die 'Production application image changed before the exclusive configuration lock was acquired.'
key=$(manifest_value "$V7_RUNTIME_CONFIG" oauth_secret_key)
created=$(manifest_value "$V7_RUNTIME_CONFIG" created_at_utc)
temporary="${V7_RUNTIME_CONFIG}.tmp.$$"
{
  printf 'format_version=1\n'
  printf 'oauth_secret_key=%s\n' "$key"
  printf 'private_integration_hosts=%s\n' "$hosts"
  printf 'created_at_utc=%s\n' "$created"
  printf 'updated_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$temporary"
chown root:root -- "$temporary"
chmod 0600 -- "$temporary"
mv -- "$temporary" "$V7_RUNTIME_CONFIG"
validate_v7_runtime_config
sync -f "$V7_RUNTIME_CONFIG"
sync -f "$STATE_ROOT"
printf 'Updated private-integration allowlist; OAuth encryption key retained unchanged.\n'
