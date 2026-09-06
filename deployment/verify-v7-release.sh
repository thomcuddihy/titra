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

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage:
  $0 --release-dir deployment/dist-v7/RELEASE_ID [--node EXECUTABLE]

The Node executable defaults to \$NODE_BIN, then to "node". A Windows node.exe
path exposed through WSL is supported by the packaged static verifier.
EOF
}

release_dir_argument=''
node_bin=${NODE_BIN:-node}
while (( $# > 0 )); do
  case $1 in
    --release-dir)
      (( $# >= 2 )) || die '--release-dir requires a directory.'
      release_dir_argument=$2
      shift 2
      ;;
    --node)
      (( $# >= 2 )) || die '--node requires an executable path or command name.'
      node_bin=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown r7 verification argument: $1"
      ;;
  esac
done
[[ -n $release_dir_argument ]] || { usage >&2; die '--release-dir is required.'; }
[[ -n $node_bin && $node_bin != *$'\n'* && $node_bin != *$'\r'* && $node_bin != *$'\t'* ]] ||
  die 'Node executable contains an invalid control character.'
release_dir=$(readlink -f -- "$release_dir_argument") || die 'Cannot resolve release directory.'
[[ -d $release_dir && ! -L $release_dir ]] || die 'Release directory is absent or unsafe.'
bundle="${release_dir}/titra-r7-release-bundle.tar"
console="${release_dir}/titra-maintenance-console-r7.sh"
release_files=(
  'titra-maintenance-console-r7.sh'
  'titra-maintenance-console-r7.sh.sha256'
  'titra-r7-release-bundle.tar'
  'titra-r7-release-bundle.tar.sha256'
)
for relative_file in "${release_files[@]}"; do
  file="${release_dir}/${relative_file}"
  [[ -f $file && ! -L $file ]] || die "Release file is absent or unsafe: ${file}"
done
cmp --silent \
  <(printf '%s\n' "${release_files[@]}" | LC_ALL=C sort) \
  <(find "$release_dir" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort) ||
  die 'Release directory inventory differs from the reviewed four-file contract.'
[[ -z $(find "$release_dir" -mindepth 1 ! -type f -print -quit) ]] ||
  die 'Release directory contains a directory, link, or special object.'
verify_exact_sidecar() {
  local target=$1 sidecar=$2 expected_digest expected_line
  [[ $(awk 'END {print NR + 0}' "$sidecar") == '1' ]] ||
    die "Release sidecar must contain exactly one record: ${sidecar}"
  expected_digest=$(sha256sum --binary "$target" | awk '{print $1}')
  expected_line="${expected_digest}  $(basename -- "$target")"
  [[ $(sed -n '1p' "$sidecar") == "$expected_line" ]] ||
    die "Release sidecar is not bound to its fixed target: ${sidecar}"
  (cd -- "$release_dir" && sha256sum --check --strict "$(basename -- "$sidecar")" >/dev/null) ||
    die "Release sidecar failed: ${sidecar}"
}
verify_exact_sidecar "$bundle" "${bundle}.sha256"
verify_exact_sidecar "$console" "${console}.sha256"
bash -n "$console"
grep -E '__V7_[A-Za-z0-9_]+__' "$console" >/dev/null &&
  die 'Console contains an unrendered placeholder.'

work_root=$(mktemp -d)
cleanup() { rm -rf -- "$work_root"; }
trap cleanup EXIT INT TERM HUP
members="${work_root}/members"
types="${work_root}/types"
tar --list --file "$bundle" --quoting-style=escape > "$members"
tar --list --verbose --file "$bundle" --quoting-style=escape > "$types"
[[ $(sed -n '1p' "$members") == 'titra-remote-test-r7/' ]] || die 'Bundle root is invalid.'
awk '
  $0 !~ /^titra-remote-test-r7(\/[A-Za-z0-9._-]+)*\/?$/ ||
  $0 ~ /(^|\/)\.\.?($|\/)/ || seen[$0]++ {bad=1}
  END {exit bad}
' "$members" || die 'Bundle contains an unsafe or duplicate path.'
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {bad=1} END {exit bad}' "$types" ||
  die 'Bundle contains a link or special object.'
tar --extract --file "$bundle" --directory "$work_root" \
  --no-same-owner --no-same-permissions --no-overwrite-dir
package_root="${work_root}/titra-remote-test-r7"
(
  cd -- "$package_root"
  sha256sum --check --strict SHA256SUMS >/dev/null
) || die 'Extracted package checksum verification failed.'
bash "${package_root}/tests/verify-package-static.sh" \
  --node "$node_bin" --console-source "$console"
printf 'Complete maintenance-r7 release verification passed.\n'
