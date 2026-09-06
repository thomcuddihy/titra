#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
umask 077

unset CDPATH ENV BASH_ENV COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME
unset COMPOSE_ENV_FILES COMPOSE_PROFILES DOCKER_CONTEXT
export DOCKER_HOST='unix:///var/run/docker.sock'

readonly DESTINATION='__V7_INSTALL_ROOT__'
readonly STATE_ROOT='__V7_STATE_ROOT__'
readonly DEPLOYMENT_RUN_ROOT="${STATE_ROOT}/production-deployments-v7"
readonly ROLLBACK_RUN_ROOT="${STATE_ROOT}/production-rollbacks-v7"
readonly BACKUP_BASE='__V7_BACKUP_ROOT__'
readonly LOG_BASE="${STATE_ROOT}/logs-v7"
readonly V7_RUNTIME_CONFIG="${STATE_ROOT}/v7-runtime.env"
readonly V7_SOURCE_ARCHIVE_ROOT="${BACKUP_BASE}/v7-source-images"
readonly LIVE_PROD_COMPOSE_FILE='__V7_PROD_COMPOSE_FILE__'
readonly TRUSTED_PROD_COMPOSE_DIR="${STATE_ROOT}/production-compose"
readonly TRUSTED_PROD_COMPOSE_FILE="${TRUSTED_PROD_COMPOSE_DIR}/docker-compose.yml"
readonly TRUSTED_PROD_COMPOSE_ENV_FILE="${TRUSTED_PROD_COMPOSE_DIR}/empty.env"
readonly EXPECTED_PROD_COMPOSE_SHA256='__V7_PROD_COMPOSE_SHA256__'
readonly EXPECTED_PROD_COMPOSE_BYTES='__V7_PROD_COMPOSE_BYTES__'
readonly EXPECTED_HOST_FQDN='__V7_EXPECTED_HOST_FQDN__'
readonly LOCK_DIR='__V7_LOCK_DIR__'
readonly LOCK_FILE="${LOCK_DIR}/operator.lock"
readonly EXPECTED_CONFIRMATION='INSTALL VERIFIED TITRA REMOTE TEST R7 PACKAGE'
readonly EXPECTED_PACKAGE_RELEASE_ID='__V7_PACKAGE_RELEASE_ID__'
readonly TITRA_ARCHIVE='__V7_TITRA_IMAGE_ARCHIVE__'
readonly MONGO_ARCHIVE='__V7_MONGO_IMAGE_ARCHIVE__'
readonly V6_ARCHIVE='__V7_V6_IMAGE_ARCHIVE__'
LOCK_FD=''

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mode_is_safe() {
  local mode=$1
  (( (8#${mode} & 8#022) == 0 ))
}

require_safe_path_chain() {
  local path=$1
  local owner mode
  path=$(readlink -f -- "$path") || die "Cannot resolve source path: $path"
  while :; do
    owner=$(stat -c '%u' -- "$path")
    mode=$(stat -c '%a' -- "$path")
    [[ $owner == '0' ]] || die "Refusing root execution from a non-root-owned path: ${path}"
    mode_is_safe "$mode" || die "Refusing root execution from a group/other-writable path: ${path}"
    [[ $path == '/' ]] && break
    path=$(dirname -- "$path")
  done
}

require_complete_checksum_manifest() {
  local root=$1
  (
    cd -- "$root"
    awk '
      {
        digest=substr($0,1,64)
        separator=substr($0,65,2)
        path=substr($0,67)
        if (length(digest) != 64 || digest !~ /^[0-9a-f]+$/ ||
            separator != "  " || path !~ /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/) {
          bad=1
        }
      }
      END { if (bad) exit 1 }
    ' SHA256SUMS
  ) || die 'SHA256SUMS contains an invalid record.'
  cmp --silent \
    <(cd -- "$root" && find . -type f ! -path './SHA256SUMS' -printf '%P\n' | LC_ALL=C sort) \
    <(cd -- "$root" && awk '{ print substr($0, 67) }' SHA256SUMS | LC_ALL=C sort) ||
    die 'SHA256SUMS does not cover every package file exactly once.'
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
  mode_is_safe "$mode" || die 'Live production Compose file is group/other-writable.'
  [[ $size == "$EXPECTED_PROD_COMPOSE_BYTES" ]] ||
    die "Live production Compose size changed. Expected ${EXPECTED_PROD_COMPOSE_BYTES}; found ${size}."
  digest=$(dd if="$LIVE_PROD_COMPOSE_FILE" iflag=nofollow,nonblock,count_bytes,fullblock \
    count=$((EXPECTED_PROD_COMPOSE_BYTES + 1)) status=none | sha256sum | awk '{print $1}') ||
    die 'Unable to read live production Compose without following symlinks.'
  after=$(stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' -- "$LIVE_PROD_COMPOSE_FILE") ||
    die 'Cannot re-inspect the live production Compose file.'
  [[ $before == "$after" ]] || die 'Live production Compose changed while it was being checked.'
  [[ $digest == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
    die "Live production Compose checksum changed. Expected ${EXPECTED_PROD_COMPOSE_SHA256}; found ${digest}."
  printf '%s\n' "$digest"
}

copy_live_compose_snapshot() {
  local destination=$1
  local temporary before after digest
  stable_live_compose_digest >/dev/null
  before=$(stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' -- "$LIVE_PROD_COMPOSE_FILE")
  temporary="${destination}.tmp.$$"
  [[ ! -e $temporary ]] || die "Trusted Compose temporary path already exists: ${temporary}"
  dd if="$LIVE_PROD_COMPOSE_FILE" of="$temporary" \
    iflag=nofollow,nonblock,count_bytes,fullblock oflag=nofollow \
    count=$((EXPECTED_PROD_COMPOSE_BYTES + 1)) conv=excl,fsync status=none ||
    die 'Failed to copy live Compose through a no-follow read.'
  after=$(stat -c '%d:%i:%u:%g:%a:%s:%Y:%Z' -- "$LIVE_PROD_COMPOSE_FILE")
  [[ $before == "$after" ]] || die 'Live production Compose changed during trusted snapshot copy.'
  [[ -f $temporary && ! -L $temporary ]] || die 'Trusted Compose temporary copy is not regular.'
  [[ $(stat -c '%s' -- "$temporary") == "$EXPECTED_PROD_COMPOSE_BYTES" ]] ||
    die 'Trusted Compose temporary copy has an unexpected size.'
  digest=$(sha256sum --binary "$temporary" | awk '{print $1}')
  [[ $digest == "$EXPECTED_PROD_COMPOSE_SHA256" ]] || die 'Trusted Compose temporary copy failed SHA-256 verification.'
  chown root:root -- "$temporary"
  chmod 0600 -- "$temporary"
  mv -- "$temporary" "$destination"
  [[ -f $destination && ! -L $destination && \
    $(stat -c '%u:%g:%a:%s' -- "$destination") == "0:0:600:${EXPECTED_PROD_COMPOSE_BYTES}" ]] ||
    die 'Installed trusted Compose snapshot has unsafe identity, mode, or size.'
  [[ $(sha256sum --binary "$destination" | awk '{print $1}') == "$EXPECTED_PROD_COMPOSE_SHA256" ]] ||
    die 'Installed trusted Compose snapshot failed final SHA-256 verification.'
}

require_install_capacity() {
  local package_root=$1
  local package_bytes available total reserve required
  package_bytes=$(du -sb -- "$package_root" | awk '{print $1}')
  available=$(df --output=avail -B1 -- "$(dirname -- "$DESTINATION")" | awk 'NR == 2 {print $1}')
  total=$(df --output=size -B1 -- "$(dirname -- "$DESTINATION")" | awk 'NR == 2 {print $1}')
  [[ $package_bytes =~ ^[0-9]+$ && $available =~ ^[0-9]+$ && $total =~ ^[0-9]+$ ]] ||
    die 'Unable to calculate installation filesystem capacity.'
  reserve=$((total / 10))
  (( reserve >= 2147483648 )) || reserve=2147483648
  (( reserve <= 10737418240 )) || reserve=10737418240
  required=$((package_bytes + reserve))
  (( available >= required )) ||
    die "Insufficient install-filesystem capacity: free=${available}, package-plus-reserve=${required}."
  printf 'Installation capacity passed: package=%s reserve=%s available=%s.\n' \
    "$package_bytes" "$reserve" "$available"
}

validate_host() {
  local actual
  actual=$(hostname --fqdn | tr '[:upper:]' '[:lower:]' | sed 's/[.]$//') ||
    die 'Unable to determine host FQDN.'
  [[ $actual == "$EXPECTED_HOST_FQDN" ]] ||
    die "Wrong host. Expected ${EXPECTED_HOST_FQDN}; found ${actual}."
}

validate_install_lock_objects() {
  [[ -d $LOCK_DIR && ! -L $LOCK_DIR ]] || die "Operator lock directory is unsafe: ${LOCK_DIR}"
  require_safe_path_chain "$LOCK_DIR"
  [[ $(stat -c '%a' -- "$LOCK_DIR") == '700' ]] || die 'Operator lock directory mode is not 0700.'
  [[ -f $LOCK_FILE && ! -L $LOCK_FILE ]] || die "Operator lock file is unsafe: ${LOCK_FILE}"
  require_safe_path_chain "$LOCK_FILE"
  [[ $(stat -c '%u:%g:%a:%h' -- "$LOCK_FILE") == '0:0:600:1' ]] ||
    die 'Operator lock must be root:root mode 0600 with one hard link.'
}

inspect_install_lock_for_dry_run() {
  if [[ ! -e $LOCK_DIR ]]; then
    printf 'Operator lock is not installed yet; a real install will create a private root-only lock.\n'
    return 0
  fi
  validate_install_lock_objects
  exec {LOCK_FD}<"$LOCK_FILE"
  flock --shared --nonblock "$LOCK_FD" || die 'Another Titra package operation holds the operator lock.'
}

acquire_install_exclusive_lock() {
  if [[ -n $LOCK_FD ]]; then
    flock --unlock "$LOCK_FD" >/dev/null 2>&1 || true
    exec {LOCK_FD}>&-
    LOCK_FD=''
  fi
  if [[ ! -e $LOCK_DIR ]]; then
    install -d -o root -g root -m 0700 -- "$LOCK_DIR"
  fi
  [[ -d $LOCK_DIR && ! -L $LOCK_DIR ]] || die "Operator lock directory is unsafe: ${LOCK_DIR}"
  require_safe_path_chain "$LOCK_DIR"
  [[ $(stat -c '%a' -- "$LOCK_DIR") == '700' ]] || die 'Operator lock directory mode is not 0700.'
  if [[ ! -e $LOCK_FILE ]]; then
    (umask 077; : > "$LOCK_FILE")
  fi
  [[ -f $LOCK_FILE && ! -L $LOCK_FILE ]] || die "Operator lock file is unsafe: ${LOCK_FILE}"
  chown root:root -- "$LOCK_FILE"
  chmod 0600 -- "$LOCK_FILE"
  validate_install_lock_objects
  exec {LOCK_FD}<>"$LOCK_FILE"
  flock --exclusive --nonblock "$LOCK_FD" || die 'Another Titra package operation holds the operator lock.'
}

[[ ${EUID} -eq 0 ]] || die 'Installer must be run as root.'
dry_run=false
if [[ $# -eq 1 && $1 == '--dry-run' ]]; then
  dry_run=true
elif [[ $# -eq 2 && $1 == '--confirm' && $2 == "$EXPECTED_CONFIRMATION" ]]; then
  dry_run=false
else
  die "Usage: $0 --dry-run | --confirm '${EXPECTED_CONFIRMATION}'"
fi

source_script_dir=$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")")
package_root=$(readlink -f -- "${source_script_dir}/..")
[[ $package_root != "$DESTINATION" ]] ||
  die 'Refusing in-place installation. Run only from a separate root-owned quarantine directory.'
require_safe_path_chain "$package_root"

for command_name in readlink stat sha256sum find awk sort cmp cp install chmod chown mv dd du df grep hostname tr sed flock date paste base64 openssl wc; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required command is unavailable: ${command_name}"
done
validate_host
if [[ $dry_run == true ]]; then
  inspect_install_lock_for_dry_run
fi

required_files=(
  'SHA256SUMS'
  'README-FIRST.md'
  'INTEGRATION-NOTES.md'
  'manifest/release.env'
  'evidence/candidate-image/SHA256SUMS'
  'evidence/candidate-image/admission.env'
  'evidence/candidate-image/build-context.manifest'
  'evidence/candidate-image/build-context.sha256'
  'evidence/candidate-image/image-history.txt'
  'evidence/candidate-image/image-inspect.json'
  'evidence/candidate-image/meteor-packages.txt'
  'evidence/candidate-image/runtime-node-packages.txt'
  'evidence/candidate-image/runtime-os-packages.txt'
  'evidence/mongo-image.env'
  'operator/README.md'
  'tests/verify-package-static.sh'
  "$TITRA_ARCHIVE"
  "${TITRA_ARCHIVE}.sha256"
  "$MONGO_ARCHIVE"
  "${MONGO_ARCHIVE}.sha256"
  "$V6_ARCHIVE"
  "${V6_ARCHIVE}.sha256"
  'lab/compose.yml'
  'lab/lib.sh'
  'lab/lock-bootstrap.sh'
  'lab/lab-up.sh'
  'lab/lab-down.sh'
  'lab/lab-status.sh'
  'lab/lab-restore.sh'
  'lab/lab-switch-image.sh'
  'lab/sanitize-clone.js'
  'lab/tcp-proxy.mjs'
  'root-scripts/common.sh'
  'root-scripts/v7-transition.sh'
  'root-scripts/configure-v7-runtime.sh'
  'root-scripts/personal-task-suggestion-preflight.cjs'
  'root-scripts/preflight-personal-task-suggestions.sh'
  'root-scripts/v7-data-compatibility-preflight.cjs'
  'root-scripts/preflight-v7-data-compatibility.sh'
  'root-scripts/install.sh'
  'root-scripts/preflight-production-deploy.sh'
  'root-scripts/status.sh'
  'root-scripts/load-release-images.sh'
  'root-scripts/backup-production-db.sh'
  'root-scripts/deploy-production-candidate.sh'
  'root-scripts/rollback-production-candidate.sh'
  'tests/preflight-personal-task-suggestions.test.mjs'
  'tests/preflight-v7-data-compatibility.test.mjs'
  'tests/r7-package-contract.test.mjs'
  'tests/test_verify_docker_save_archive.py'
  'tests/verify_docker_save_archive.py'
  'tests/failure-rehearsal.sh'
)
for relative_path in "${required_files[@]}"; do
  [[ -f ${package_root}/${relative_path} && ! -L ${package_root}/${relative_path} ]] ||
    die "Required package file is missing or is a symlink: ${relative_path}"
done
cmp --silent \
  <(printf '%s\n' "${required_files[@]}" | LC_ALL=C sort) \
  <(cd -- "$package_root" && find . -type f -printf '%P\n' | LC_ALL=C sort) ||
  die 'Package file inventory differs from the exhaustive reviewed allowlist.'
package_device=$(stat -c '%d' -- "$package_root")
while IFS= read -r -d '' package_directory; do
  [[ $(stat -c '%d' -- "$package_directory") == "$package_device" ]] ||
    die "Package contains a nested mountpoint or filesystem boundary: ${package_directory}"
done < <(find "$package_root" -xdev -mindepth 1 -type d -print0)

special_path=$(find "$package_root" ! -type d ! -type f -print -quit)
[[ -z $special_path ]] ||
  die "Package contains a symlink, device, socket, FIFO, or other special file: ${special_path}"
while IFS= read -r -d '' package_path; do
  [[ $(stat -c '%u' -- "$package_path") == '0' ]] ||
    die "Package object is not root-owned: ${package_path}"
  mode=$(stat -c '%a' -- "$package_path")
  mode_is_safe "$mode" || die "Package object is group/other-writable: ${package_path}"
done < <(find "$package_root" -print0)

require_complete_checksum_manifest "$package_root"
(
  cd -- "$package_root"
  sha256sum --check --strict SHA256SUMS
) || die 'Source package checksum verification failed.'
if [[ -e $DESTINATION || -L $DESTINATION ]]; then
  [[ -d $DESTINATION && ! -L $DESTINATION ]] || die 'Existing r7 installation path is unsafe.'
  require_safe_path_chain "$DESTINATION"
  [[ -f ${DESTINATION}/SHA256SUMS && ! -L ${DESTINATION}/SHA256SUMS ]] ||
    die 'Existing r7 installation has no safe checksum manifest.'
  require_complete_checksum_manifest "$DESTINATION"
  (cd -- "$DESTINATION" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
    die 'Existing installation failed exhaustive checksum verification.'
fi
grep -Fx -- 'RELEASE_FORMAT=7' "${package_root}/manifest/release.env" >/dev/null ||
  die 'Source package release manifest format is not the reviewed format 7.'
grep -Fx -- "PACKAGE_RELEASE_ID=${EXPECTED_PACKAGE_RELEASE_ID}" \
  "${package_root}/manifest/release.env" >/dev/null ||
  die 'Source package release ID is not the reviewed maintenance-r7 revision.'
[[ $EXPECTED_PACKAGE_RELEASE_ID == *'-maintenance-r7' ]] ||
  die 'Installer release ID does not use the maintenance-r7 suffix.'

if [[ $dry_run != true ]]; then
  acquire_install_exclusive_lock
  validate_host
  stable_live_compose_digest >/dev/null
  require_install_capacity "$package_root"
  require_complete_checksum_manifest "$package_root"
  (
    cd -- "$package_root"
    sha256sum --check --strict SHA256SUMS >/dev/null
  ) || die 'Source package changed before the exclusive install lock was acquired.'
fi

for required_parent in "$(dirname -- "$DESTINATION")" "$(dirname -- "$STATE_ROOT")" "$(dirname -- "$BACKUP_BASE")"; do
  [[ -d $required_parent && ! -L $required_parent ]] ||
    die "Configured parent directory is missing or is a symlink: ${required_parent}"
  require_safe_path_chain "$required_parent"
done
if [[ -e $STATE_ROOT ]]; then
  [[ -d $STATE_ROOT && ! -L $STATE_ROOT ]] || die "State root is not a direct directory: ${STATE_ROOT}"
  require_safe_path_chain "$STATE_ROOT"
fi
if [[ -e $BACKUP_BASE ]]; then
  [[ -d $BACKUP_BASE && ! -L $BACKUP_BASE ]] || die "Backup root is not a direct directory: ${BACKUP_BASE}"
  require_safe_path_chain "$BACKUP_BASE"
fi
if [[ -e $LOG_BASE ]]; then
  [[ -d $LOG_BASE && ! -L $LOG_BASE ]] || die "Log root is not a direct directory: ${LOG_BASE}"
  require_safe_path_chain "$LOG_BASE"
fi
stable_live_compose_digest >/dev/null
require_install_capacity "$package_root"
if [[ -e $DESTINATION ]]; then
  require_safe_path_chain "$DESTINATION"
fi
if [[ $dry_run == true ]]; then
  printf 'Dry run passed: the complete package is root-owned, contains only regular files/directories,\n'
  printf 'is fully covered by SHA256SUMS, and every checksum is valid.\n'
  printf 'The live Compose file is a stable root-owned direct file with the exact approved SHA-256.\n'
  printf 'No files, directories, permissions, ownership, images, containers, or state were changed.\n'
  printf 'Required installation confirmation: %s\n' "$EXPECTED_CONFIRMATION"
  exit 0
fi

install_parent=$(dirname -- "$DESTINATION")
installing="${install_parent}/.$(basename -- "$DESTINATION").installing.$$"
previous=''
installation_complete=false
publication_started=false
prepared_root_identity=''
installer_cleanup() {
  local rc=$?
  local failed_install='' published_identity=''
  trap - EXIT INT TERM HUP
  set +e
  if [[ $installation_complete != true && $publication_started == true && \
    ( -e $DESTINATION || -L $DESTINATION ) ]]; then
    if [[ -d $DESTINATION && ! -L $DESTINATION ]]; then
      published_identity=$(stat -Lc '%d:%i' -- "$DESTINATION" 2>/dev/null)
    fi
    if [[ -z $prepared_root_identity || $published_identity != "$prepared_root_identity" ]]; then
      printf 'CRITICAL: refusing to move an unexpected object from the installation destination: %s.\n' \
        "$DESTINATION" >&2
      if [[ -n $previous && -e $previous ]]; then
        printf 'The previous package remains available at %s.\n' "$previous" >&2
      fi
      exit "$rc"
    fi
    failed_install="${DESTINATION}.failed.$(date -u '+%Y%m%dT%H%M%SZ').$$"
    if [[ ! -e $failed_install && ! -L $failed_install ]] && \
      mv -T -- "$DESTINATION" "$failed_install"; then
      printf 'Incomplete published installation retained at %s.\n' "$failed_install" >&2
    else
      printf 'CRITICAL: could not move the incomplete published installation aside: %s.\n' \
        "$DESTINATION" >&2
      if [[ -n $previous && -e $previous ]]; then
        printf 'The previous package remains available at %s.\n' "$previous" >&2
      fi
      exit "$rc"
    fi
  fi
  if [[ $installation_complete != true && -n $previous && -e $previous ]]; then
    if [[ ! -e $DESTINATION ]] && mv -- "$previous" "$DESTINATION"; then
      printf 'Restored the previous installed package after installer failure.\n' >&2
    else
      printf 'CRITICAL: automatic restoration of the previous package failed; inspect %s and %s.\n' \
        "$DESTINATION" "$previous" >&2
    fi
  fi
  if [[ $installation_complete != true && -n $installing && -e $installing ]]; then
    printf 'Incomplete pre-rename installation retained for inspection at %s.\n' "$installing" >&2
  fi
  exit "$rc"
}
trap installer_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

[[ ! -e $installing ]] || die "Temporary install path already exists: ${installing}"
install -d -o root -g root -m 0750 "$installing"
cp -a -- "${package_root}/." "${installing}/"
chown -R root:root -- "$installing"
(
  cd -- "$installing"
  sha256sum --check --strict SHA256SUMS
) || die 'Post-copy package checksum verification failed.'

find "$installing" -type d -exec chmod 0750 -- {} +
find "$installing" -type f -exec chmod 0640 -- {} +
find "${installing}/root-scripts" "${installing}/lab" "${installing}/tests" \
  -type f -name '*.sh' \
  -exec chmod 0750 -- {} +
chmod 0644 -- "${installing}/lab/sanitize-clone.js" "${installing}/lab/tcp-proxy.mjs"
prepared_root_identity=$(stat -Lc '%d:%i' -- "$installing") ||
  die 'Unable to capture the prepared package identity before publication.'

# Prepare and verify every shared prerequisite before publishing the package at
# its canonical path.  This keeps first installation atomic from the console's
# point of view: an r7 package cannot become visible while state initialization
# is still incomplete.  If this block fails, an existing r5 package (if any)
# remains untouched and the prepared copy is retained for inspection.
install -d -o root -g root -m 0700 "$STATE_ROOT" "${STATE_ROOT}/production-images" \
  "$TRUSTED_PROD_COMPOSE_DIR" "$DEPLOYMENT_RUN_ROOT" "$ROLLBACK_RUN_ROOT" "$LOG_BASE" \
  "$V7_SOURCE_ARCHIVE_ROOT"
copy_live_compose_snapshot "$TRUSTED_PROD_COMPOSE_FILE"
compose_env_temporary="${TRUSTED_PROD_COMPOSE_ENV_FILE}.tmp.$$"
[[ ! -e $compose_env_temporary ]] || die "Trusted Compose environment temporary path already exists: ${compose_env_temporary}"
(umask 077; : > "$compose_env_temporary")
chown root:root -- "$compose_env_temporary"
chmod 0600 -- "$compose_env_temporary"
mv -- "$compose_env_temporary" "$TRUSTED_PROD_COMPOSE_ENV_FILE"
[[ -f $TRUSTED_PROD_COMPOSE_ENV_FILE && ! -L $TRUSTED_PROD_COMPOSE_ENV_FILE && \
  $(stat -c '%u:%g:%a:%s' -- "$TRUSTED_PROD_COMPOSE_ENV_FILE") == '0:0:600:0' ]] ||
  die 'Installed trusted Compose environment file has unsafe identity, mode, or size.'
install -d -o root -g root -m 0700 "$BACKUP_BASE" \
  "${BACKUP_BASE}/production" "${BACKUP_BASE}/pre-restore" \
  "${BACKUP_BASE}/images" "${BACKUP_BASE}/lab" "$V7_SOURCE_ARCHIVE_ROOT"

# Create the OAuth sealing key once and retain it across every later install,
# deployment, and rollback. The key is never written to console or support logs.
if [[ -e $V7_RUNTIME_CONFIG || -L $V7_RUNTIME_CONFIG ]]; then
  [[ -f $V7_RUNTIME_CONFIG && ! -L $V7_RUNTIME_CONFIG &&
    $(stat -c '%u:%g:%a:%h' -- "$V7_RUNTIME_CONFIG") == '0:0:600:1' ]] ||
    die 'Existing v7 runtime configuration is unsafe.'
else
  runtime_created=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  oauth_secret_key=$(openssl rand -base64 16 | tr -d '\n')
  [[ $oauth_secret_key =~ ^[A-Za-z0-9+/]{22}==$ &&
    $(printf '%s' "$oauth_secret_key" | base64 --decode 2>/dev/null | wc -c | awk '{print $1}') == '16' ]] ||
    die 'Failed to generate a canonical 16-byte OAuth encryption key.'
  runtime_temporary="${V7_RUNTIME_CONFIG}.tmp.$$"
  (set -o noclobber; umask 077; {
    printf 'format_version=1\n'
    printf 'oauth_secret_key=%s\n' "$oauth_secret_key"
    printf 'private_integration_hosts=\n'
    printf 'created_at_utc=%s\n' "$runtime_created"
    printf 'updated_at_utc=%s\n' "$runtime_created"
  } > "$runtime_temporary")
  chown root:root -- "$runtime_temporary"
  chmod 0600 -- "$runtime_temporary"
  mv -- "$runtime_temporary" "$V7_RUNTIME_CONFIG"
  unset oauth_secret_key
fi
runtime_keys=$(awk -F= '{print $1}' "$V7_RUNTIME_CONFIG" | paste -sd ',' -)
[[ $runtime_keys == 'format_version,oauth_secret_key,private_integration_hosts,created_at_utc,updated_at_utc' ]] ||
  die 'V7 runtime configuration has an unexpected schema.'
runtime_key=$(sed -n 's/^oauth_secret_key=//p' "$V7_RUNTIME_CONFIG")
[[ $(grep -c '^oauth_secret_key=' "$V7_RUNTIME_CONFIG") == '1' &&
  $runtime_key =~ ^[A-Za-z0-9+/]{22}==$ &&
  $(printf '%s' "$runtime_key" | base64 --decode 2>/dev/null | wc -c | awk '{print $1}') == '16' ]] ||
  die 'V7 runtime OAuth key is invalid; it was not replaced or rotated.'
unset runtime_key
runtime_hosts=$(sed -n 's/^private_integration_hosts=//p' "$V7_RUNTIME_CONFIG")
[[ ${#runtime_hosts} -le 8192 && $runtime_hosts != *$'\n'* && $runtime_hosts != *$'\r'* &&
  $runtime_hosts != *$'\t'* ]] || die 'Existing v7 private-integration host list is invalid.'
if [[ -n $runtime_hosts ]]; then
  IFS=',' read -r -a runtime_host_entries <<< "$runtime_hosts"
  for runtime_host in "${runtime_host_entries[@]}"; do
    [[ -n $runtime_host && $runtime_host == "${runtime_host,,}" && $runtime_host != *' '* &&
      $runtime_host =~ ^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\]|[0-9a-f:]+)$ &&
      $runtime_host != *'..'* && $runtime_host != *'*'* ]] ||
      die 'Existing v7 private-integration host list contains an invalid entry.'
  done
fi
unset runtime_hosts runtime_host runtime_host_entries
runtime_created=$(sed -n 's/^created_at_utc=//p' "$V7_RUNTIME_CONFIG")
runtime_updated=$(sed -n 's/^updated_at_utc=//p' "$V7_RUNTIME_CONFIG")
[[ $runtime_created =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
  $runtime_updated =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  die 'V7 runtime timestamps are invalid.'
runtime_created_epoch=$(date -u -d "$runtime_created" '+%s' 2>/dev/null) || die 'V7 runtime creation time is invalid.'
runtime_updated_epoch=$(date -u -d "$runtime_updated" '+%s' 2>/dev/null) || die 'V7 runtime update time is invalid.'
(( runtime_updated_epoch >= runtime_created_epoch )) || die 'V7 runtime update time precedes its creation time.'
unset runtime_created runtime_updated runtime_created_epoch runtime_updated_epoch
sync -f "$V7_RUNTIME_CONFIG"
sync -f "$STATE_ROOT"

if [[ -e $DESTINATION ]]; then
  require_safe_path_chain "$DESTINATION"
  previous="${DESTINATION}.previous.$(date -u '+%Y%m%dT%H%M%SZ')"
  [[ ! -e $previous ]] || die "Previous-package destination exists: ${previous}"
  mv -- "$DESTINATION" "$previous"
  printf 'Previous installed package retained at %s.\n' "$previous"
fi
publication_started=true
mv -T -- "$installing" "$DESTINATION"
installing=''
require_safe_path_chain "$DESTINATION"
(
  cd -- "$DESTINATION"
  sha256sum --check --strict SHA256SUMS
) || die 'Installed package checksum verification failed.'

installation_complete=true
trap - EXIT INT TERM HUP
printf 'Installed and reverified the complete root-owned package at %s.\n' "$DESTINATION"
printf 'Other maintenance package locations were not changed.\n'
printf 'Read %s/operator/README.md, then inspect transition status:\n' "$DESTINATION"
printf '  %s/root-scripts/status.sh\n' "$DESTINATION"
