#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
LC_ALL=C
export LC_ALL
PYTHONDONTWRITEBYTECODE=1
export PYTHONDONTWRITEBYTECODE
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PACKAGE_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd -P)
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

node_bin=${NODE_BIN:-node}
console_source=''
while (( $# > 0 )); do
  case $1 in
    --node) (( $# >= 2 )) || die '--node requires an executable.'; node_bin=$2; shift 2 ;;
    --console-source) (( $# >= 2 )) || die '--console-source requires a file.'; console_source=$2; shift 2 ;;
    --help|-h) printf 'Usage: %s [--node EXECUTABLE] [--console-source FILE]\n' "$0"; exit 0 ;;
    *) die 'Invalid static-verifier argument.' ;;
  esac
done
if [[ -z $console_source ]]; then
  console_source="${PACKAGE_ROOT}/../remote-console-v7/titra-maintenance-console-r7.sh.in"
fi
[[ -f $console_source && ! -L $console_source ]] || die 'R7 console source is absent or unsafe.'

if [[ $node_bin == */* ]]; then node_exec=$node_bin; else node_exec=$(type -P -- "$node_bin"); fi
[[ -f $node_exec && -x $node_exec ]] || die 'Node executable is unavailable.'
run_node_test() {
  local test_file=$1 converted
  if [[ ${node_exec,,} == *.exe ]]; then
    command -v wslpath >/dev/null 2>&1 || die 'Windows Node requires wslpath.'
    converted=$(wslpath -w -- "$test_file")
    "$node_exec" "$converted" --console-source "$(wslpath -w -- "$console_source")"
  else
    TITRA_R7_CONSOLE_SOURCE=$console_source "$node_exec" --test "$test_file"
  fi
}

for command_name in awk bash basename cmp dirname find grep gzip paste python3 sed sha256sum sort stat; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required verifier command is unavailable: ${command_name}"
done
[[ -z $(find "$PACKAGE_ROOT" -type d -name '__pycache__' -print -quit) ]] ||
  die 'Package contains a Python bytecode cache directory.'
[[ -z $(find "$PACKAGE_ROOT" -type f \( -name '*.pyc' -o -name '*.pyo' \) -print -quit) ]] ||
  die 'Package contains a Python bytecode cache file.'
find "$PACKAGE_ROOT/root-scripts" "$PACKAGE_ROOT/lab" "$PACKAGE_ROOT/tests" \
  -type f -name '*.sh' -print0 | while IFS= read -r -d '' script; do bash -n "$script"; done
bash -n "$console_source"
run_node_test "$PACKAGE_ROOT/tests/preflight-personal-task-suggestions.test.mjs"
run_node_test "$PACKAGE_ROOT/tests/preflight-v7-data-compatibility.test.mjs"
run_node_test "$PACKAGE_ROOT/tests/r7-package-contract.test.mjs"
python3 "$PACKAGE_ROOT/tests/test_verify_docker_save_archive.py"
bash "$PACKAGE_ROOT/tests/failure-rehearsal.sh"

manifest="$PACKAGE_ROOT/manifest/release.env"
[[ $(awk 'END {print NR + 0}' "$manifest") == 25 ]] || die 'R7 release manifest must contain 25 records.'
actual_keys=$(awk -F= '{print $1}' "$manifest" | LC_ALL=C sort | paste -sd ',' -)
expected_keys='MONGO_CONFIG_IMAGE_ID,MONGO_IMAGE_ARCHIVE,MONGO_SOURCE_DIGEST,MONGO_TEST_IMAGE,MONGO_TEST_IMAGE_ID,PACKAGE_RELEASE_ID,RELEASE_FORMAT,RELEASE_PROFILE,SOURCE_COMMIT,SOURCE_CONTEXT_SHA256,STOCK_IMAGE,STOCK_IMAGE_ID,TITRA_CONFIG_IMAGE_ID,TITRA_IMAGE_ARCHIVE,TITRA_IMAGE_EVIDENCE_DIRECTORY,TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256,TITRA_TEST_IMAGE,TITRA_TEST_IMAGE_ID,TITRA_VERSION,V5_IMAGE,V5_IMAGE_ID,V6_CONFIG_IMAGE_ID,V6_IMAGE,V6_IMAGE_ARCHIVE,V6_IMAGE_ID'
[[ $actual_keys == "$expected_keys" ]] || die 'R7 release manifest keys differ from the reviewed schema.'
grep -Fx 'RELEASE_FORMAT=7' "$manifest" >/dev/null || die 'R7 release format is not 7.'
manifest_value() {
  local key=$1
  [[ $(grep -c "^${key}=" "$manifest") == 1 ]] || die "Manifest ${key} record is not unique."
  sed -n "s/^${key}=//p" "$manifest"
}
for key in TITRA_TEST_IMAGE_ID TITRA_CONFIG_IMAGE_ID STOCK_IMAGE_ID V5_IMAGE_ID V6_IMAGE_ID V6_CONFIG_IMAGE_ID MONGO_TEST_IMAGE_ID MONGO_CONFIG_IMAGE_ID; do
  [[ $(manifest_value "$key") =~ ^sha256:[0-9a-f]{64}$ ]] || die "Manifest ${key} is invalid."
done
[[ $(manifest_value MONGO_SOURCE_DIGEST) =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die 'Manifest Mongo source digest is invalid.'
[[ $(manifest_value RELEASE_PROFILE) =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  die 'Manifest release profile is invalid.'
grep -E "^readonly EXPECTED_PROD_COMPOSE_SHA256='[0-9a-f]{64}'$" \
  "$PACKAGE_ROOT/root-scripts/common.sh" >/dev/null ||
  die 'Rendered production Compose SHA-256 is invalid.'
grep -E "^readonly EXPECTED_PROD_COMPOSE_BYTES='[1-9][0-9]*'$" \
  "$PACKAGE_ROOT/root-scripts/common.sh" >/dev/null ||
  die 'Rendered production Compose size is invalid.'

mongo_evidence="$PACKAGE_ROOT/evidence/mongo-image.env"
[[ -f $mongo_evidence && ! -L $mongo_evidence ]] || die 'Mongo admission metadata is absent or unsafe.'
[[ $(awk -F= '{print $1}' "$mongo_evidence" | paste -sd ',' -) == \
  'format_version,source_ref,archive_ref,build_engine_image_id,config_image_id,archive_sha256,created_at_utc' ]] ||
  die 'Mongo admission metadata schema is invalid.'
mongo_evidence_value() {
  local key=$1
  [[ $(grep -c "^${key}=" "$mongo_evidence") == '1' ]] || die "Mongo metadata ${key} is not unique."
  sed -n "s/^${key}=//p" "$mongo_evidence"
}
[[ $(mongo_evidence_value format_version) == '1' &&
  $(mongo_evidence_value source_ref) == *@"$(manifest_value MONGO_SOURCE_DIGEST)" &&
  $(mongo_evidence_value archive_ref) == "$(manifest_value MONGO_TEST_IMAGE)" &&
  $(mongo_evidence_value build_engine_image_id) == "$(manifest_value MONGO_TEST_IMAGE_ID)" &&
  $(mongo_evidence_value config_image_id) == "$(manifest_value MONGO_CONFIG_IMAGE_ID)" ]] ||
  die 'Mongo admission metadata differs from the release manifest.'
[[ $(mongo_evidence_value build_engine_image_id) =~ ^sha256:[0-9a-f]{64}$ &&
  $(mongo_evidence_value created_at_utc) =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'Mongo admission metadata build identity or timestamp is invalid.'

(cd -- "$PACKAGE_ROOT" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
  die 'Package SHA256SUMS verification failed.'
for archive_key in TITRA_IMAGE_ARCHIVE V6_IMAGE_ARCHIVE MONGO_IMAGE_ARCHIVE; do
  relative=$(manifest_value "$archive_key")
  [[ $relative =~ ^images/[A-Za-z0-9][A-Za-z0-9._-]*[.]tar[.]gz$ ]] || die "Unsafe ${archive_key}."
  archive="$PACKAGE_ROOT/$relative"
  [[ -f $archive && ! -L $archive ]] || die "Missing ${archive_key} archive."
  gzip --test -- "$archive"
  sidecar="${archive}.sha256"
  [[ -f $sidecar && ! -L $sidecar && $(awk 'END {print NR + 0}' "$sidecar") == 1 ]] ||
    die "Invalid ${archive_key} checksum sidecar."
  (cd -- "$(dirname -- "$archive")" && sha256sum --check --strict "$(basename -- "$sidecar")" >/dev/null) ||
    die "${archive_key} sidecar verification failed."
done
[[ $(mongo_evidence_value archive_sha256) == \
  "$(sha256sum --binary "$PACKAGE_ROOT/$(manifest_value MONGO_IMAGE_ARCHIVE)" | awk '{print $1}')" ]] ||
  die 'Mongo admission metadata archive digest differs from the packaged archive.'

evidence="$PACKAGE_ROOT/$(manifest_value TITRA_IMAGE_EVIDENCE_DIRECTORY)"
[[ -d $evidence && ! -L $evidence ]] || die 'Candidate evidence directory is absent or unsafe.'
[[ $(sha256sum --binary "$evidence/SHA256SUMS" | awk '{print $1}') == \
  "$(manifest_value TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256)" ]] ||
  die 'Candidate evidence checksum-manifest identity differs from the release manifest.'
(cd -- "$evidence" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
  die 'Candidate evidence checksum verification failed.'

python3 "$PACKAGE_ROOT/tests/verify_docker_save_archive.py" \
  --archive "$PACKAGE_ROOT/$(manifest_value TITRA_IMAGE_ARCHIVE)" \
  --expected-ref "$(manifest_value TITRA_TEST_IMAGE)" \
  --expected-id "$(manifest_value TITRA_TEST_IMAGE_ID)" \
  --expected-config-id "$(manifest_value TITRA_CONFIG_IMAGE_ID)" \
  --expected-source-context "$(manifest_value SOURCE_CONTEXT_SHA256)" \
  --expected-source-commit "$(manifest_value SOURCE_COMMIT)" \
  --expected-version "$(manifest_value TITRA_VERSION)" \
  --expected-build-variant "$(manifest_value RELEASE_PROFILE)" \
  --require-portable-candidate
python3 "$PACKAGE_ROOT/tests/verify_docker_save_archive.py" \
  --archive "$PACKAGE_ROOT/$(manifest_value V6_IMAGE_ARCHIVE)" \
  --expected-ref "$(manifest_value V6_IMAGE)" \
  --expected-id "$(manifest_value V6_IMAGE_ID)" \
  --expected-config-id "$(manifest_value V6_CONFIG_IMAGE_ID)"
python3 "$PACKAGE_ROOT/tests/verify_docker_save_archive.py" \
  --archive "$PACKAGE_ROOT/$(manifest_value MONGO_IMAGE_ARCHIVE)" \
  --expected-ref "$(manifest_value MONGO_TEST_IMAGE)" \
  --expected-id "$(manifest_value MONGO_TEST_IMAGE_ID)" \
  --expected-config-id "$(manifest_value MONGO_CONFIG_IMAGE_ID)" \
  --require-portable-candidate

grep -F 'FULL ROLLBACK TITRA' "$PACKAGE_ROOT/root-scripts/rollback-production-candidate.sh" >/dev/null ||
  die 'Rollback lacks the reviewed full-restore confirmation.'
grep -F 'drop_production_database' "$PACKAGE_ROOT/root-scripts/rollback-production-candidate.sh" >/dev/null ||
  die 'Rollback does not restore the original database.'
grep -F 'openssl rand -base64 16' "$PACKAGE_ROOT/root-scripts/install.sh" >/dev/null ||
  die 'Installer does not generate the persistent OAuth encryption key.'
grep -F 'validate_no_unsafe_production_bootstrap_flags' "$PACKAGE_ROOT/root-scripts/preflight-production-deploy.sh" >/dev/null ||
  die 'Production preflight lacks the temporary-admin flag gate.'
grep -F 'preflight-v7-data-compatibility.sh" --preview' "$PACKAGE_ROOT/root-scripts/preflight-production-deploy.sh" >/dev/null ||
  die 'Production preflight lacks the v7 stored-data preview gate.'
grep -F 'preflight-v7-data-compatibility.sh" --require-app-stopped' "$PACKAGE_ROOT/root-scripts/deploy-production-candidate.sh" >/dev/null ||
  die 'Production deployment lacks the authoritative stopped v7 stored-data gate.'
grep -F -- '--leave-app-stopped --dry-run' "$PACKAGE_ROOT/root-scripts/deploy-production-candidate.sh" >/dev/null ||
  die 'Production deployment does not rehearse the continuous-stop backup handoff.'
grep -F -- '--leave-app-stopped' "$PACKAGE_ROOT/root-scripts/backup-production-db.sh" >/dev/null ||
  die 'Production backup lacks the continuous-stop handoff mode.'
grep -F 'Application handoff: exact source container remains stopped' "$PACKAGE_ROOT/root-scripts/backup-production-db.sh" >/dev/null ||
  die 'Production backup lacks an explicit stopped-source handoff receipt.'
grep -F -- '--leave-app-stopped --dry-run' "$PACKAGE_ROOT/root-scripts/rollback-production-candidate.sh" >/dev/null ||
  die 'Rollback does not keep a running target stopped after its safety backup.'
grep -F 'exact-target-restarted-before-restore' "$PACKAGE_ROOT/root-scripts/rollback-production-candidate.sh" >/dev/null ||
  die 'Rollback lacks safe exact-target recovery before destructive work.'
grep -F 'ACKNOWLEDGE V7 DATA COMPATIBILITY WARNINGS' "$PACKAGE_ROOT/root-scripts/preflight-v7-data-compatibility.sh" >/dev/null ||
  die 'Stopped v7 warnings lack an attended marker-bound acknowledgement.'
grep -F "'secure_webhook_missing_secrets'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate does not fail closed for unprovisioned action-verification webhooks.'
grep -F "'active_timer_identity_malformed'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits malformed active-timer identity state.'
grep -F "'credential_object_fields'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits pre-existing sealed credential state.'
grep -F "'credential_oversized_plaintext_fields'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits oversized plaintext credential state.'
grep -F "'admin_inactive_flags_malformed'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits malformed strict-admin inactive state.'
grep -F "'dashboard_slug_key_shape_malformed'" "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits exact unique-index key-shape validation.'
grep -F 'function verificationMalformedFlagsPipeline' "$PACKAGE_ROOT/root-scripts/v7-data-compatibility-preflight.cjs" >/dev/null ||
  die 'V7 data gate omits exact verification object/flag shape validation.'

printf 'R7 package static verification passed.\n'
