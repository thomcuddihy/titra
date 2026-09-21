#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
export PYTHONDONTWRITEBYTECODE=1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DEPLOYMENT_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd -P)
fixture_root=$(mktemp -d)
release_id="test-$$-maintenance-r7"
output_root="${DEPLOYMENT_ROOT}/dist-v7/${release_id}"
cleanup() {
  rm -rf -- "$fixture_root"
  case $output_root in
    "${DEPLOYMENT_ROOT}/dist-v7/test-"*'-maintenance-r7') rm -rf -- "$output_root" ;;
    *) printf 'Refusing unexpected generated-output cleanup: %s\n' "$output_root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM HUP

fixture_args=()
if [[ ${TEST_PREVIOUS_V7:-no} == yes ]]; then fixture_args=(with-attestation); fi
python3 "${SCRIPT_DIR}/build-release-fixture.py" "${fixture_root}/inputs" testprofile "${fixture_args[@]}"
# shellcheck disable=SC1091 -- generated, fixed-schema test data
source "${fixture_root}/inputs/fixture.env"

previous_args=()
if [[ ${TEST_PREVIOUS_V7:-no} == yes ]]; then
  previous_args=(
    --previous-v7-ref local/titra:previous-v7
    --previous-v7-id "sha256:$(printf 'e%.0s' {1..64})"
    --previous-v7-config-id "sha256:$(printf 'f%.0s' {1..64})"
  )
fi

run_builder() {
"${DEPLOYMENT_ROOT}/build-v7-release.sh" \
  --release-id "$release_id" \
  --release-profile "$RELEASE_PROFILE" \
  --titra-version 1.0.12 \
  --candidate-ref "$CANDIDATE_REF" \
  --candidate-id "$CANDIDATE_ID" \
  --candidate-config-id "$CANDIDATE_CONFIG_ID" \
  --candidate-archive "${fixture_root}/inputs/candidate.tar.gz" \
  --source-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --source-context-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --image-evidence-dir "${fixture_root}/inputs/evidence" \
  --compose-sha256 cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  --compose-bytes 100 \
  --stock-ref registry.example.invalid/titra:stock \
  --stock-id "$PREDECESSOR_ID" \
  --v5-ref "$PREDECESSOR_REF" \
  --v5-id "$PREDECESSOR_ID" \
  --v6-ref "$PREDECESSOR_REF" \
  --v6-id "$PREDECESSOR_ID" \
  --v6-config-id "$PREDECESSOR_CONFIG_ID" \
  --v6-archive "${fixture_root}/inputs/predecessor.tar.gz" \
  --mongo-archive "${fixture_root}/inputs/mongo.tar.gz" \
  --mongo-metadata "${fixture_root}/inputs/mongo-image.env" \
  --mongo-attestation-id "$MONGO_ATTESTATION_ID" \
  --expected-host-fqdn titra.example.invalid \
  --production-compose-file /srv/titra/docker-compose.yml \
  --install-root /opt/titra-maintenance-r7 \
  --state-root /var/lib/titra-maintenance \
  --backup-root /var/backups/titra-maintenance \
  --lock-dir /run/titra-maintenance \
  --incoming-dir /srv/titra-maintenance/incoming \
  --console-install-dir /opt/titra-maintenance-console-r7 \
  --compose-project titra \
  --app-service titra \
  --db-service mongodb \
  --app-container titra_app \
  --db-container titra_db \
  --database titra "${previous_args[@]}" "$@"
}
run_builder

if [[ ${TEST_PREVIOUS_V7:-no} == yes ]]; then
  if run_builder --previous-v7-id "$CANDIDATE_ID" >"${fixture_root}/rejected.log" 2>&1; then
    printf 'ERROR: accepted a previous-v7 identity overlapping the candidate.\n' >&2
    exit 1
  fi
  grep -F 'Previous-v7 image identity overlaps' "${fixture_root}/rejected.log" >/dev/null
else
  if run_builder --previous-v7-ref local/titra:previous-v7 >"${fixture_root}/rejected.log" 2>&1; then
    printf 'ERROR: accepted incomplete previous-v7 admission.\n' >&2
    exit 1
  fi
  grep -F 'All three previous-v7 identity arguments' "${fixture_root}/rejected.log" >/dev/null
fi

"${DEPLOYMENT_ROOT}/verify-v7-release.sh" --release-dir "$output_root"

# Exercise the real lab manifest parser, not only static regex contracts. Use a
# synthetic runtime key and bypass only root filesystem ownership in this test.
mkdir "${fixture_root}/unpacked"
tar -xf "$output_root/titra-r7-release-bundle.tar" -C "${fixture_root}/unpacked"
package_root="${fixture_root}/unpacked/titra-remote-test-r7"
bash -s -- "$package_root/lab/lib.sh" <<'LAB_CHECK'
set -eu
source "$1"
require_secure_root_file() { :; }
read_literal_env_file() {
  local -n synthetic_runtime=$2
  synthetic_runtime[format_version]=1
  synthetic_runtime[oauth_secret_key]=AAAAAAAAAAAAAAAAAAAAAA==
  synthetic_runtime[private_integration_hosts]=''
}
load_release_manifest
[[ ${#RELEASE_VALUES[@]} == 29 ]]
[[ -n ${RELEASE_VALUES[PREVIOUS_V7_IMAGE_ID]} ]]
[[ -n ${RELEASE_VALUES[MONGO_ATTESTATION_MANIFEST_ID]} ]]
LAB_CHECK

if [[ $MONGO_ATTESTATION_ID != none ]]; then
  wrong_pin="sha256:$(printf '9%.0s' {1..64})"
  sed -i "s/^MONGO_ATTESTATION_MANIFEST_ID=.*/MONGO_ATTESTATION_MANIFEST_ID=$wrong_pin/" "$package_root/manifest/release.env"
  # Re-sign this synthetic fixture's checksum list so the test reaches semantic
  # attestation admission, rather than merely detecting changed manifest bytes.
  (
    cd -- "$package_root"
    find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum
  ) > "$package_root/SHA256SUMS"
  if bash "$package_root/tests/verify-package-static.sh" --node "${NODE_BIN:-node}" \
    --console-source "$output_root/titra-maintenance-console-r7.sh" >"${fixture_root}/bad-attestation.log" 2>&1; then
    printf 'ERROR: static package verification accepted an unreviewed Mongo attestation.\n' >&2
    exit 1
  fi
  grep -F 'reviewed OCI attestation descriptor is absent' "${fixture_root}/bad-attestation.log" >/dev/null
fi
printf 'Release-builder integration test passed.\n'
