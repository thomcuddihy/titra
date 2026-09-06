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

python3 "${SCRIPT_DIR}/build-release-fixture.py" "${fixture_root}/inputs"
# shellcheck disable=SC1091 -- generated, fixed-schema test data
source "${fixture_root}/inputs/fixture.env"

"${DEPLOYMENT_ROOT}/build-v7-release.sh" \
  --release-id "$release_id" \
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
  --database titra

"${DEPLOYMENT_ROOT}/verify-v7-release.sh" --release-dir "$output_root"
printf 'Release-builder integration test passed.\n'
