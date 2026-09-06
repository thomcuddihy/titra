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
TEMPLATE_ROOT="${SCRIPT_DIR}/remote-test-v7"
CONSOLE_TEMPLATE="${SCRIPT_DIR}/remote-console-v7/titra-maintenance-console-r7.sh.in"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage:
  $0 [--node EXECUTABLE] \\
     --release-id SAFE_ID --titra-version X.Y.Z --candidate-ref LOCAL_REF \\
     --candidate-id sha256:... --candidate-config-id sha256:... \\
     --candidate-archive FILE \\
     --source-commit 40_HEX --source-context-sha256 64_HEX \\
     --image-evidence-dir DIRECTORY \\
     --compose-sha256 64_HEX --compose-bytes INTEGER \\
     --stock-ref IMAGE_REF --stock-id sha256:... \\
     --v5-ref IMAGE_REF --v5-id sha256:... \\
     --v6-ref IMAGE_REF --v6-id sha256:... --v6-config-id sha256:... \\
     --v6-archive FILE --mongo-archive FILE --mongo-metadata FILE \\
     --expected-host-fqdn HOST --production-compose-file ABSOLUTE_PATH \\
     --install-root ABSOLUTE_PATH --state-root ABSOLUTE_PATH \\
     --backup-root ABSOLUTE_PATH --lock-dir ABSOLUTE_PATH \\
     --incoming-dir ABSOLUTE_PATH --console-install-dir ABSOLUTE_PATH \\
     --compose-project NAME --app-service NAME --db-service NAME \\
     --app-container NAME --db-container NAME --database NAME \\
     [--mongo-id sha256:...]

The builder assembles and verifies a new immutable r7 bundle. It does not build
Docker images, modify the source template, upload, install, or deploy anything.
All site identity, filesystem paths, predecessor images, and content-addressed
image IDs are explicit inputs. The builder embeds those reviewed values into an
immutable host-bound package; the repository contains no rendered site data.
An optional --mongo-id must equal the Mongo metadata's portable config image ID.
The Node executable defaults to \$NODE_BIN, then to "node". A Windows node.exe
path exposed through WSL is supported; test paths are translated with wslpath.
EOF
}

node_bin=${NODE_BIN:-node}
release_id=''
titra_version=''
candidate_ref=''
candidate_id=''
candidate_config_id=''
candidate_archive=''
source_commit=''
source_context_sha=''
image_evidence_dir=''
compose_sha=''
compose_bytes=''
stock_ref=''
stock_id=''
mongo_id=''
mongo_archive=''
mongo_metadata=''
v5_ref=''
v5_id=''
v6_ref=''
v6_id=''
v6_config_id=''
v6_archive=''
expected_host=''
production_compose_file=''
install_root=''
state_root=''
backup_root=''
lock_dir=''
incoming_dir=''
console_install_dir=''
compose_project=''
app_service=''
db_service=''
app_container=''
db_container=''
database_name=''
while (( $# > 0 )); do
  case $1 in
    --node)
      (( $# >= 2 )) || die '--node requires an executable path or command name.'
      node_bin=$2
      shift 2
      ;;
    --release-id) release_id=${2:-}; shift 2 ;;
    --titra-version) titra_version=${2:-}; shift 2 ;;
    --candidate-ref) candidate_ref=${2:-}; shift 2 ;;
    --candidate-id) candidate_id=${2:-}; shift 2 ;;
    --candidate-config-id) candidate_config_id=${2:-}; shift 2 ;;
    --candidate-archive) candidate_archive=${2:-}; shift 2 ;;
    --source-commit) source_commit=${2:-}; shift 2 ;;
    --source-context-sha256) source_context_sha=${2:-}; shift 2 ;;
    --image-evidence-dir) image_evidence_dir=${2:-}; shift 2 ;;
    --compose-sha256) compose_sha=${2:-}; shift 2 ;;
    --compose-bytes) compose_bytes=${2:-}; shift 2 ;;
    --stock-ref) stock_ref=${2:-}; shift 2 ;;
    --stock-id) stock_id=${2:-}; shift 2 ;;
    --v5-ref) v5_ref=${2:-}; shift 2 ;;
    --v5-id) v5_id=${2:-}; shift 2 ;;
    --v6-ref) v6_ref=${2:-}; shift 2 ;;
    --v6-id) v6_id=${2:-}; shift 2 ;;
    --v6-config-id) v6_config_id=${2:-}; shift 2 ;;
    --mongo-id) mongo_id=${2:-}; shift 2 ;;
    --mongo-archive) mongo_archive=${2:-}; shift 2 ;;
    --mongo-metadata) mongo_metadata=${2:-}; shift 2 ;;
    --v6-archive) v6_archive=${2:-}; shift 2 ;;
    --expected-host-fqdn) expected_host=${2:-}; shift 2 ;;
    --production-compose-file) production_compose_file=${2:-}; shift 2 ;;
    --install-root) install_root=${2:-}; shift 2 ;;
    --state-root) state_root=${2:-}; shift 2 ;;
    --backup-root) backup_root=${2:-}; shift 2 ;;
    --lock-dir) lock_dir=${2:-}; shift 2 ;;
    --incoming-dir) incoming_dir=${2:-}; shift 2 ;;
    --console-install-dir) console_install_dir=${2:-}; shift 2 ;;
    --compose-project) compose_project=${2:-}; shift 2 ;;
    --app-service) app_service=${2:-}; shift 2 ;;
    --db-service) db_service=${2:-}; shift 2 ;;
    --app-container) app_container=${2:-}; shift 2 ;;
    --db-container) db_container=${2:-}; shift 2 ;;
    --database) database_name=${2:-}; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown r7 build argument.' ;;
  esac
done

[[ $release_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,200}-maintenance-r7$ ]] ||
  die '--release-id must be a safe immutable maintenance-r7 ID.'
[[ $candidate_ref =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ && $candidate_ref != *:latest ]] ||
  die '--candidate-ref must be a safe non-latest local tag.'
[[ $titra_version =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || die '--titra-version is invalid.'
[[ $candidate_id =~ ^sha256:[0-9a-f]{64}$ ]] || die '--candidate-id is invalid.'
[[ $candidate_config_id =~ ^sha256:[0-9a-f]{64}$ ]] || die '--candidate-config-id is invalid.'
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || die '--source-commit must be 40 lowercase hexadecimal characters.'
[[ $source_context_sha =~ ^[0-9a-f]{64}$ ]] || die '--source-context-sha256 is invalid.'
expected_candidate_tag="${titra_version}-${source_commit:0:12}-ctx${source_context_sha:0:12}-security1-amd64"
[[ ${candidate_ref##*:} == "$expected_candidate_tag" ]] ||
  die '--candidate-ref does not use the exact immutable v7 security1 tag.'
[[ $compose_sha =~ ^[0-9a-f]{64}$ ]] || die '--compose-sha256 is invalid.'
[[ $compose_bytes =~ ^[1-9][0-9]*$ ]] || die '--compose-bytes is invalid.'
[[ $stock_ref =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] || die '--stock-ref is invalid.'
[[ $v5_ref =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] || die '--v5-ref is invalid.'
[[ $v6_ref =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] || die '--v6-ref is invalid.'
for image_id in "$stock_id" "$v5_id" "$v6_id" "$v6_config_id"; do
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'A source image ID is invalid.'
done
[[ $expected_host =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && $expected_host != *'..'* ]] ||
  die '--expected-host-fqdn is invalid.'
validate_absolute_path() {
  local label=$1 value=$2
  [[ $value =~ ^/[A-Za-z0-9._/-]+$ && $value != '/' && $value != *'//'*
    && $value != *'/../'* && $value != */.. && $value != *'/./'* ]] ||
    die "${label} must be a canonical-looking absolute path below /."
}
validate_absolute_path '--production-compose-file' "$production_compose_file"
validate_absolute_path '--install-root' "$install_root"
validate_absolute_path '--state-root' "$state_root"
validate_absolute_path '--backup-root' "$backup_root"
validate_absolute_path '--lock-dir' "$lock_dir"
validate_absolute_path '--incoming-dir' "$incoming_dir"
validate_absolute_path '--console-install-dir' "$console_install_dir"
configured_roots=("$install_root" "$state_root" "$backup_root" "$lock_dir" "$incoming_dir" "$console_install_dir")
for (( left = 0; left < ${#configured_roots[@]}; left++ )); do
  for (( right = left + 1; right < ${#configured_roots[@]}; right++ )); do
    [[ ${configured_roots[left]} != "${configured_roots[right]}" &&
      ${configured_roots[left]} != "${configured_roots[right]}/"* &&
      ${configured_roots[right]} != "${configured_roots[left]}/"* ]] ||
      die 'Configured install, state, backup, lock, incoming, and console roots must not overlap.'
  done
done
for service_name in "$compose_project" "$app_service" "$db_service" "$app_container" "$db_container" "$database_name"; do
  [[ $service_name =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
    die 'A Compose service, container, project, or database identity is invalid.'
done
for archive in "$candidate_archive" "$mongo_archive" "$v6_archive"; do
  [[ -f $archive && ! -L $archive ]] || die "Required image archive is absent or unsafe: ${archive}"
  gzip --test -- "$archive"
done
[[ -f $mongo_metadata && ! -L $mongo_metadata ]] || die 'Mongo admission metadata is absent or unsafe.'
mongo_metadata_keys=$(awk -F= '{print $1}' "$mongo_metadata" | paste -sd ',' -)
[[ $mongo_metadata_keys == 'format_version,source_ref,archive_ref,build_engine_image_id,config_image_id,archive_sha256,created_at_utc' ]] ||
  die 'Mongo admission metadata has an unexpected schema.'
metadata_value() {
  local key=$1 count value
  count=$(grep -c "^${key}=" "$mongo_metadata" || true)
  [[ $count == '1' ]] || die "Mongo admission metadata must contain exactly one ${key}."
  value=$(sed -n "s/^${key}=//p" "$mongo_metadata")
  printf '%s\n' "$value"
}
metadata_mongo_source_ref=$(metadata_value source_ref)
metadata_mongo_ref=$(metadata_value archive_ref)
[[ $(metadata_value format_version) == '1' &&
  $metadata_mongo_source_ref =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ &&
  $metadata_mongo_ref =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ ]] ||
  die 'Mongo admission metadata has an invalid source digest or archive reference.'
metadata_mongo_source_digest=${metadata_mongo_source_ref##*@}
metadata_mongo_id=$(metadata_value config_image_id)
[[ $metadata_mongo_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Mongo config image ID is invalid.'
metadata_mongo_test_id=$(metadata_value build_engine_image_id)
[[ $metadata_mongo_test_id =~ ^sha256:[0-9a-f]{64}$ ]] ||
  die 'Mongo build-engine image ID is invalid.'
[[ $(metadata_value created_at_utc) =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'Mongo admission timestamp is invalid.'
[[ $(metadata_value archive_sha256) == "$(sha256sum --binary "$mongo_archive" | awk '{print $1}')" ]] ||
  die 'Mongo archive digest differs from its admission metadata.'
if [[ -n $mongo_id ]]; then
  [[ $mongo_id =~ ^sha256:[0-9a-f]{64}$ && $mongo_id == "$metadata_mongo_id" ]] ||
    die '--mongo-id differs from the admitted Mongo config image ID.'
else
  mongo_id=$metadata_mongo_id
fi
[[ -d $TEMPLATE_ROOT && ! -L $TEMPLATE_ROOT ]] || die 'R7 package template is absent or unsafe.'
[[ -f $CONSOLE_TEMPLATE && ! -L $CONSOLE_TEMPLATE ]] || die 'R7 console template is absent or unsafe.'
for command_name in awk bash basename cmp cp dirname find grep gzip install mktemp mv paste python3 rm sed sha256sum sort stat tar wc xargs; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required build command is unavailable: ${command_name}"
done
[[ -n $node_bin && $node_bin != *$'\n'* && $node_bin != *$'\r'* && $node_bin != *$'\t'* ]] ||
  die 'Node executable contains an invalid control character.'
if [[ $node_bin == */* ]]; then
  [[ -f $node_bin && -x $node_bin ]] || die "Node executable is absent or not executable: ${node_bin}"
  node_exec=$node_bin
else
  node_exec=$(type -P -- "$node_bin") || die "Node executable is unavailable: ${node_bin}"
fi
node_is_windows=false
if [[ ${node_exec,,} == *.exe ]]; then
  command -v -- wslpath >/dev/null 2>&1 ||
    die 'A Windows Node executable requires wslpath for test-path translation.'
  node_is_windows=true
fi
run_node_tests() {
  local test_path converted
  local -a arguments=(--test)
  for test_path in "$@"; do
    [[ -f $test_path && ! -L $test_path ]] || die "Node test file is absent or unsafe: ${test_path}"
    if [[ $node_is_windows == true ]]; then
      converted=$(wslpath -w -- "$test_path") || die "Unable to translate Node test path: ${test_path}"
      [[ -n $converted && $converted != *$'\n'* && $converted != *$'\r'* && $converted != *$'\t'* ]] ||
        die "Translated Node test path is invalid: ${test_path}"
      # Node's --test file discovery rejects WSL UNC paths. A node:test module
      # executed directly still emits TAP and returns a failing exit status.
      "$node_exec" "$converted"
    else
      arguments+=("$test_path")
    fi
  done
  if [[ $node_is_windows != true ]]; then
    "$node_exec" "${arguments[@]}"
  fi
}
[[ -d $image_evidence_dir && ! -L $image_evidence_dir ]] ||
  die '--image-evidence-dir must be a direct directory.'
evidence_files=(
  'SHA256SUMS'
  'admission.env'
  'build-context.manifest'
  'build-context.sha256'
  'image-history.txt'
  'image-inspect.json'
  'meteor-packages.txt'
  'runtime-node-packages.txt'
  'runtime-os-packages.txt'
)
cmp --silent \
  <(printf '%s\n' "${evidence_files[@]}" | LC_ALL=C sort) \
  <(find "$image_evidence_dir" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort) ||
  die 'Candidate evidence inventory differs from the reviewed nine-file contract.'
[[ -z $(find "$image_evidence_dir" -mindepth 1 ! -type f -print -quit) ]] ||
  die 'Candidate evidence contains a directory, link, or special object.'
evidence_bytes=0
for evidence_file in "${evidence_files[@]}"; do
  [[ -f ${image_evidence_dir}/${evidence_file} && ! -L ${image_evidence_dir}/${evidence_file} ]] ||
    die "Candidate evidence file is absent or unsafe: ${evidence_file}"
  file_bytes=$(stat -c '%s' -- "${image_evidence_dir}/${evidence_file}")
  (( file_bytes <= 67108864 )) || die "Candidate evidence file is unreasonably large: ${evidence_file}"
  evidence_bytes=$((evidence_bytes + file_bytes))
done
(( evidence_bytes <= 134217728 )) || die 'Candidate evidence directory is unreasonably large.'
(
  cd -- "$image_evidence_dir"
  awk '
    {
      digest=substr($0,1,64)
      separator=substr($0,65,2)
      path=substr($0,67)
      if (length(digest) != 64 || digest !~ /^[0-9a-f]+$/ ||
          separator != "  " || path !~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/) {
        bad=1
      }
    }
    END { if (bad) exit 1 }
  ' SHA256SUMS || die 'Candidate evidence SHA256SUMS contains an invalid record.'
  cmp --silent \
    <(printf '%s\n' "${evidence_files[@]}" | grep -Fvx 'SHA256SUMS' | LC_ALL=C sort) \
    <(awk '{print substr($0, 67)}' SHA256SUMS | LC_ALL=C sort) ||
    die 'Candidate evidence SHA256SUMS does not cover the reviewed evidence inventory.'
  sha256sum --check --strict SHA256SUMS >/dev/null
) || die 'Candidate image evidence checksum verification failed.'
evidence_sha=$(sha256sum --binary "${image_evidence_dir}/SHA256SUMS" | awk '{print $1}')
run_node_tests "${SCRIPT_DIR}/remote-console-v7/titra-maintenance-console-r7.test.mjs"

candidate_name=$(basename -- "$candidate_archive")
[[ $candidate_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$ ]] ||
  die 'Candidate archive basename is unsafe.'
candidate_archive_sha=$(sha256sum --binary "$candidate_archive" | awk '{print $1}')
candidate_archive_bytes=$(stat -c '%s' -- "$candidate_archive")
candidate_relative="images/${candidate_name}"
mongo_name=$(basename -- "$mongo_archive")
v6_name=$(basename -- "$v6_archive")
[[ $mongo_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$ ]] || die 'Mongo archive basename is unsafe.'
[[ $v6_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$ ]] || die 'V6 archive basename is unsafe.'
mongo_relative="images/${mongo_name}"
v6_relative="images/${v6_name}"
candidate_evidence_relative='evidence/candidate-image'
output_root="${SCRIPT_DIR}/dist-v7/${release_id}"
[[ ! -e $output_root ]] || die "Output already exists; review it rather than overwrite: ${output_root}"

work_root=$(mktemp -d)
cleanup() { rm -rf -- "$work_root"; }
trap cleanup EXIT INT TERM HUP
stage="${work_root}/titra-remote-test-r7"
cp -a -- "$TEMPLATE_ROOT" "$stage"
[[ -f ${stage}/manifest/release.env.in && ! -e ${stage}/manifest/release.env ]] ||
  die 'Release manifest template is absent or a rendered manifest is tracked.'
mv -- "${stage}/manifest/release.env.in" "${stage}/manifest/release.env"
# Python's import machinery can leave host-specific bytecode caches in the
# source template. They are not release inputs and would violate the root
# installer's exhaustive file inventory. Remove them only from this disposable
# staging copy, then prevent package-verification tests from recreating them.
while IFS= read -r -d '' cache_directory; do
  rm -rf --one-file-system -- "$cache_directory"
done < <(find "$stage" -type d -name '__pycache__' -print0)
[[ -z $(find "$stage" -type f \( -name '*.pyc' -o -name '*.pyo' \) -print -quit) ]] ||
  die 'Python bytecode cache remained in the release stage.'
install -d -m 0700 -- "${stage}/images"
install -d -m 0700 -- "${stage}/${candidate_evidence_relative}"
install -m 0600 -- "$candidate_archive" "${stage}/${candidate_relative}"
install -m 0600 -- "$mongo_archive" "${stage}/${mongo_relative}"
install -m 0600 -- "$v6_archive" "${stage}/${v6_relative}"
install -m 0600 -- "$mongo_metadata" "${stage}/evidence/mongo-image.env"
for evidence_file in "${evidence_files[@]}"; do
  install -m 0600 -- "${image_evidence_dir}/${evidence_file}" \
    "${stage}/${candidate_evidence_relative}/${evidence_file}"
done

python3 - "$stage" \
  '__V7_PACKAGE_RELEASE_ID__' "$release_id" \
  '__V7_TITRA_VERSION__' "$titra_version" \
  '__V7_TITRA_IMAGE__' "$candidate_ref" \
  '__V7_TITRA_IMAGE_ID__' "$candidate_id" \
  '__V7_TITRA_CONFIG_IMAGE_ID__' "$candidate_config_id" \
  '__V7_TITRA_IMAGE_ARCHIVE__' "$candidate_relative" \
  '__V7_MONGO_TEST_IMAGE__' "$metadata_mongo_ref" \
  '__V7_MONGO_TEST_IMAGE_ID__' "$metadata_mongo_test_id" \
  '__V7_MONGO_CONFIG_IMAGE_ID__' "$mongo_id" \
  '__V7_MONGO_SOURCE_DIGEST__' "$metadata_mongo_source_digest" \
  '__V7_MONGO_IMAGE_ARCHIVE__' "$mongo_relative" \
  '__V7_SOURCE_COMMIT__' "$source_commit" \
  '__V7_SOURCE_CONTEXT_SHA256__' "$source_context_sha" \
  '__V7_TITRA_IMAGE_EVIDENCE_SHA256SUMS_SHA256__' "$evidence_sha" \
  '__V7_STOCK_IMAGE__' "$stock_ref" \
  '__V7_STOCK_IMAGE_ID__' "$stock_id" \
  '__V7_V5_IMAGE__' "$v5_ref" \
  '__V7_V5_IMAGE_ID__' "$v5_id" \
  '__V7_V6_IMAGE__' "$v6_ref" \
  '__V7_V6_IMAGE_ID__' "$v6_id" \
  '__V7_V6_CONFIG_IMAGE_ID__' "$v6_config_id" \
  '__V7_V6_IMAGE_ARCHIVE__' "$v6_relative" \
  '__V7_PROD_COMPOSE_SHA256__' "$compose_sha" \
  '__V7_PROD_COMPOSE_BYTES__' "$compose_bytes" \
  '__V7_EXPECTED_HOST_FQDN__' "$expected_host" \
  '__V7_PROD_COMPOSE_FILE__' "$production_compose_file" \
  '__V7_INSTALL_ROOT__' "$install_root" \
  '__V7_STATE_ROOT__' "$state_root" \
  '__V7_BACKUP_ROOT__' "$backup_root" \
  '__V7_LOCK_DIR__' "$lock_dir" \
  '__V7_INCOMING_DIR__' "$incoming_dir" \
  '__V7_CONSOLE_INSTALL_DIR__' "$console_install_dir" \
  '__V7_PROD_PROJECT__' "$compose_project" \
  '__V7_APP_SERVICE__' "$app_service" \
  '__V7_DB_SERVICE__' "$db_service" \
  '__V7_APP_CONTAINER__' "$app_container" \
  '__V7_DB_CONTAINER__' "$db_container" \
  '__V7_PROD_DATABASE__' "$database_name" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
pairs = dict(zip(sys.argv[2::2], sys.argv[3::2], strict=True))
placeholder_pattern = re.compile(r'__V7_[A-Za-z0-9_]+__')
for path in root.rglob('*'):
    if not path.is_file() or {'images', 'evidence'} & set(path.relative_to(root).parts):
        continue
    text = path.read_text(encoding='utf-8')
    for token, value in pairs.items():
        text = text.replace(token, value)
    path.write_text(text, encoding='utf-8', newline='\n')
remaining = []
for path in root.rglob('*'):
    if path.is_file() and not ({'images', 'evidence'} & set(path.relative_to(root).parts)):
        placeholders = sorted(set(placeholder_pattern.findall(path.read_text(encoding='utf-8'))))
        if placeholders:
            remaining.append(f'{path}: {", ".join(placeholders)}')
if remaining:
    raise SystemExit(f'unrendered v7 placeholders: {remaining}')
PY

for archive in "$candidate_relative" "$mongo_relative" "$v6_relative"; do
  digest=$(sha256sum --binary "${stage}/${archive}" | awk '{print $1}')
  printf '%s  %s\n' "$digest" "$(basename -- "$archive")" > "${stage}/${archive}.sha256"
done
(
  cd -- "$stage"
  find . -type f ! -path './SHA256SUMS' -printf '%P\0' | sort -z | xargs -0 sha256sum
) > "${stage}/SHA256SUMS"
chmod 0600 -- "${stage}/SHA256SUMS"
bash "${stage}/tests/verify-package-static.sh" \
  --node "$node_exec" --console-source "$CONSOLE_TEMPLATE"
package_sha=$(sha256sum --binary "${stage}/SHA256SUMS" | awk '{print $1}')

install -d -m 0700 -- "$output_root"
bundle="${output_root}/titra-r7-release-bundle.tar"
tar --create --file "$bundle" --directory "$work_root" \
  --sort=name --mtime='UTC 2026-09-01 00:00:00' \
  --owner=0 --group=0 --numeric-owner --mode='u+rwX,go-rwx' \
  titra-remote-test-r7
bundle_bytes=$(stat -c '%s' -- "$bundle")
bundle_sha=$(sha256sum --binary "$bundle" | awk '{print $1}')
bundle_members=$(tar --list --file "$bundle" | wc -l | awk '{print $1}')
printf '%s  titra-r7-release-bundle.tar\n' "$bundle_sha" > "${bundle}.sha256"

console="${output_root}/titra-maintenance-console-r7.sh"
cp -- "$CONSOLE_TEMPLATE" "$console"
python3 - "$console" \
  '__V7_PACKAGE_RELEASE_ID__' "$release_id" \
  '__V7_PACKAGE_SHA256SUMS_SHA256__' "$package_sha" \
  '__V7_BUNDLE_SHA256__' "$bundle_sha" \
  '__V7_BUNDLE_BYTES__' "$bundle_bytes" \
  '__V7_BUNDLE_MEMBERS__' "$bundle_members" \
  '__V7_EXPECTED_HOST_FQDN__' "$expected_host" \
  '__V7_INCOMING_DIR__' "$incoming_dir" \
  '__V7_INSTALL_ROOT__' "$install_root" \
  '__V7_STATE_ROOT__' "$state_root" \
  '__V7_CONSOLE_INSTALL_DIR__' "$console_install_dir" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
pairs = dict(zip(sys.argv[2::2], sys.argv[3::2], strict=True))
placeholder_pattern = re.compile(r'__V7_[A-Za-z0-9_]+__')
text = path.read_text(encoding='utf-8')
for token, value in pairs.items():
    text = text.replace(token, value)
remaining = sorted(set(placeholder_pattern.findall(text)))
if remaining:
    raise SystemExit(f'unrendered console placeholders: {remaining}')
path.write_text(text, encoding='utf-8', newline='\n')
PY
chmod 0700 -- "$console"
bash -n "$console"
console_sha=$(sha256sum --binary "$console" | awk '{print $1}')
printf '%s  titra-maintenance-console-r7.sh\n' \
  "$console_sha" > "${console}.sha256"
bash "${SCRIPT_DIR}/verify-v7-release.sh" --release-dir "$output_root" --node "$node_exec"

trap - EXIT INT TERM HUP
rm -rf -- "$work_root"
printf 'Maintenance-r7 release assembly passed.\n'
printf '  release_id=%s\n' "$release_id"
printf '  titra_version=%s\n' "$titra_version"
printf '  stock_ref=%s\n' "$stock_ref"
printf '  stock_image_id=%s\n' "$stock_id"
printf '  mongo_tested_image_id=%s\n' "$metadata_mongo_test_id"
printf '  mongo_config_image_id=%s\n' "$mongo_id"
printf '  candidate_ref=%s\n' "$candidate_ref"
printf '  candidate_image_id=%s\n' "$candidate_id"
printf '  candidate_config_image_id=%s\n' "$candidate_config_id"
printf '  candidate_archive_sha256=%s\n' "$candidate_archive_sha"
printf '  candidate_archive_bytes=%s\n' "$candidate_archive_bytes"
printf '  source_commit=%s\n' "$source_commit"
printf '  source_context_sha256=%s\n' "$source_context_sha"
printf '  evidence_sha256sums_sha256=%s\n' "$evidence_sha"
printf '  bundle=%s\n' "$bundle"
printf '  bundle_bytes=%s\n' "$bundle_bytes"
printf '  bundle_sha256=%s\n' "$bundle_sha"
printf '  bundle_members=%s\n' "$bundle_members"
printf '  package_sha256sums_sha256=%s\n' "$package_sha"
printf '  console=%s\n' "$console"
printf '  console_sha256=%s\n' "$console_sha"
