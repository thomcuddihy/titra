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
validate_production_recovery_context
validate_release_manifest
validate_no_unsafe_production_bootstrap_flags
require_secure_regular_file "${INSTALL_ROOT}/SHA256SUMS"
(cd -- "$INSTALL_ROOT" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
  die 'Installed r7 package failed exhaustive checksum verification.'

if docker container inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  current_id=$(container_value "$APP_CONTAINER" '{{.Image}}')
  current_ref=$(container_value "$APP_CONTAINER" '{{.Config.Image}}')
  running=$(container_value "$APP_CONTAINER" '{{.State.Running}}')
  if v7_image_id_is_allowed "$current_id"; then
    current_kind='v7'
  else
    current_kind=$(supported_source_kind "$current_id") || current_kind='unsupported'
  fi
else
  current_id='absent'
  current_ref='absent'
  running='false'
  current_kind='missing-recovery-required'
fi

v6_loaded='no'
v6_loaded_id='not-loaded'
if [[ -e $V6_LOADED_STATE || -L $V6_LOADED_STATE ]]; then
  v6_loaded_id=$(validate_loaded_target_state v6)
  v6_loaded='yes'
fi
v7_loaded='no'
v7_loaded_id='not-loaded'
if [[ -e $V7_LOADED_STATE || -L $V7_LOADED_STATE ]]; then
  v7_loaded_id=$(validate_loaded_target_state v7)
  v7_loaded='yes'
fi
mongo_loaded='no'
mongo_loaded_id='not-loaded'
if [[ -e $V7_MONGO_LOADED_STATE || -L $V7_MONGO_LOADED_STATE ]]; then
  mongo_loaded_id=$(validate_loaded_target_state mongo)
  mongo_loaded='yes'
fi

validate_v7_runtime_config
runtime_fingerprint=$(v7_runtime_fingerprint)
hosts=$(manifest_value "$V7_RUNTIME_CONFIG" private_integration_hosts)
host_count=0
[[ -z $hosts ]] || host_count=$(awk -F, '{print NF}' <<< "$hosts")

unfinished=0
for root in "$DEPLOYMENT_RUN_ROOT" "$ROLLBACK_RUN_ROOT"; do
  require_secure_directory "$root"
  while IFS= read -r -d '' state_file; do
    require_secure_regular_file "$state_file"
    if grep -Fx 'status=IN_PROGRESS' "$state_file" >/dev/null; then unfinished=$((unfinished + 1)); fi
  done < <(find "$root" -mindepth 2 -maxdepth 2 -name state.env -print0)
done
predecessor_unfinished=$(unfinished_predecessor_operation_count)

latest_deployment=$(find "$DEPLOYMENT_RUN_ROOT" -mindepth 2 -maxdepth 2 -type f -name receipt.env -printf '%h\n' |
  sed 's#^.*/##' | LC_ALL=C sort | tail -n 1)
latest_rollback=$(find "$ROLLBACK_RUN_ROOT" -mindepth 2 -maxdepth 2 -type f -name receipt.env -printf '%h\n' |
  sed 's#^.*/##' | LC_ALL=C sort | tail -n 1)

printf 'Titra maintenance-r7 status\n'
printf '  application running:       %s\n' "$running"
printf '  current generation:        %s\n' "$current_kind"
printf '  current image ref:         %s\n' "$current_ref"
printf '  current image ID:          %s\n' "$current_id"
printf '  v6 intermediate loaded:    %s (%s)\n' "$v6_loaded" "$v6_loaded_id"
printf '  v7 candidate loaded:       %s (%s)\n' "$v7_loaded" "$v7_loaded_id"
printf '  MongoDB 7.0.40 lab image:  %s (%s)\n' "$mongo_loaded" "$mongo_loaded_id"
printf '  OAuth encryption key:      configured and valid (value hidden)\n'
printf '  runtime config SHA-256:    %s\n' "$runtime_fingerprint"
printf '  private integration hosts: %s\n' "$host_count"
if [[ -n $hosts ]]; then printf '    %s\n' "$hosts"; fi
printf '  unfinished r7 operations:  %s\n' "$unfinished"
printf '  unfinished r5/r6 runs:     %s\n' "$predecessor_unfinished"
printf '  latest deployment run:     %s\n' "${latest_deployment:-none}"
printf '  latest rollback run:       %s\n' "${latest_rollback:-none}"
printf '  supported deployment paths:\n'
printf '    stock -> v7; v5 -> v6; v5 -> v7; v6 -> v7\n'
printf '  rollback policy:\n'
printf '    receipt-bound source image plus full predeployment database restore only\n'
[[ $current_kind != unsupported ]] ||
  die 'Current application image is outside every release-bound r7 identity.'
[[ $current_kind != missing-recovery-required ]] ||
  die 'Titra application container is absent; use a failed post-switch receipt for the full rollback recovery path.'
(( unfinished == 0 )) || die 'An unfinished r7 operation requires review before another mutation.'
(( predecessor_unfinished == 0 )) || die 'An unfinished r5/r6 operation requires review before an r7 mutation.'
