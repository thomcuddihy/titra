#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
LC_ALL=C
export LC_ALL
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SOURCE_REF='mongo:7.0.40@sha256:b6421fd6d1c5ded6377b397d8983e2f82e2100dc5123332dcfda2065a472be5b'
readonly RUNTIME_SOURCE_REF='mongo:7.0.40@sha256:76f1e3cc36f46a79f98f30736174fa0c55a2ba41d6ce860e4e551e3ffbcce009'
readonly SOURCE_INDEX_ID='sha256:b6421fd6d1c5ded6377b397d8983e2f82e2100dc5123332dcfda2065a472be5b'
readonly RUNTIME_MANIFEST_ID='sha256:76f1e3cc36f46a79f98f30736174fa0c55a2ba41d6ce860e4e551e3ffbcce009'
readonly ATTESTATION_MANIFEST_ID='sha256:827126c4761968bd2d695d1c7d69db636d392242a892c858bc50e608ae079b74'
readonly ARCHIVE_REF='mongo:7.0.40'
readonly DEFAULT_DESTINATION="${SCRIPT_DIR}/dist-v7-mongo"
readonly ARCHIVE_NAME='mongo-7.0.40-linux-amd64.tar.gz'
readonly ARCHIVE_VERIFIER="${SCRIPT_DIR}/remote-test-v7/tests/verify_docker_save_archive.py"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage: $0 [--docker EXECUTABLE] [--destination DIRECTORY]

Verify the Linux/amd64 child of the exact reviewed MongoDB 7.0.40 registry
index, pull that child manifest directly, bind it to the offline lab tag,
create a Docker-save gzip archive, and verify every archive content address.
The destination must not already exist.
EOF
}

docker_bin=${DOCKER_BIN:-docker}
destination=$DEFAULT_DESTINATION
while (( $# > 0 )); do
  case $1 in
    --docker) (( $# >= 2 )) || die '--docker requires a value.'; docker_bin=$2; shift 2 ;;
    --destination) (( $# >= 2 )) || die '--destination requires a value.'; destination=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die 'Unknown Mongo archive-build argument.' ;;
  esac
done

for command_name in awk basename chmod date dirname grep gzip mkdir mktemp mv python3 readlink rm sed sha256sum stat; do
  command -v -- "$command_name" >/dev/null 2>&1 || die "Required command is unavailable: ${command_name}"
done
if [[ $docker_bin == */* ]]; then
  [[ -f $docker_bin && -x $docker_bin ]] || die "Docker executable is absent or not executable: ${docker_bin}"
else
  command -v -- "$docker_bin" >/dev/null 2>&1 || die "Docker executable is unavailable: ${docker_bin}"
fi
docker_cmd=("$docker_bin")
"${docker_cmd[@]}" version >/dev/null || die 'Docker engine is unavailable.'
[[ -f $ARCHIVE_VERIFIER && ! -L $ARCHIVE_VERIFIER ]] || die 'Archive verifier is absent or unsafe.'

destination_parent=$(dirname -- "$destination")
destination_name=$(basename -- "$destination")
[[ $destination_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die 'Destination basename is unsafe.'
mkdir -p -- "$destination_parent"
destination_parent=$(readlink -f -- "$destination_parent") || die 'Cannot resolve destination parent.'
[[ -d $destination_parent && ! -L $destination_parent ]] || die 'Destination parent is unsafe.'
destination_absolute="${destination_parent}/${destination_name}"
[[ ! -e $destination_absolute && ! -L $destination_absolute ]] ||
  die "Destination already exists; review it rather than overwrite: ${destination_absolute}"
work_root=$(mktemp -d "${destination_parent}/.mongo-7.0.40-build.XXXXXXXX")
published=false
cleanup() {
  local resolved
  if [[ $published != true ]]; then
    resolved=$(readlink -f -- "$work_root" 2>/dev/null || true)
    if [[ -n $resolved && $resolved == "${destination_parent}/.mongo-7.0.40-build."* && -d $resolved ]]; then
      rm -rf --one-file-system -- "$resolved"
    fi
  fi
}
trap cleanup EXIT INT TERM HUP

source_index_json="${work_root}/source-index.json"
"${docker_cmd[@]}" buildx imagetools inspect --raw "$SOURCE_REF" > "$source_index_json"
python3 - "$source_index_json" "$SOURCE_INDEX_ID" "$RUNTIME_MANIFEST_ID" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
expected_index = sys.argv[2]
expected_runtime = sys.argv[3]
raw = path.read_bytes()
if f"sha256:{hashlib.sha256(raw).hexdigest()}" != expected_index:
    raise SystemExit("Mongo source-index bytes differ from the reviewed digest")
value = json.loads(raw)
descriptors = value.get("manifests") if isinstance(value, dict) else None
if (
    value.get("schemaVersion") != 2
    or value.get("mediaType") != "application/vnd.oci.image.index.v1+json"
    or not isinstance(descriptors, list)
):
    raise SystemExit("Mongo source index is malformed")
runtime = [
    item
    for item in descriptors
    if isinstance(item, dict)
    and item.get("digest") == expected_runtime
    and item.get("mediaType") == "application/vnd.oci.image.manifest.v1+json"
    and item.get("platform") == {"architecture": "amd64", "os": "linux"}
]
attestations = [
    item
    for item in descriptors
    if isinstance(item, dict)
    and item.get("annotations", {}).get("vnd.docker.reference.type")
    == "attestation-manifest"
    and item.get("annotations", {}).get("vnd.docker.reference.digest")
    == expected_runtime
    and item.get("platform") == {"architecture": "unknown", "os": "unknown"}
]
if len(runtime) != 1 or len(attestations) != 1:
    raise SystemExit(
        "Mongo source index does not bind one Linux/amd64 runtime and attestation"
    )
PY
rm -- "$source_index_json"

# Pulling the multi-platform index itself makes containerd-backed Docker save
# its attestation descriptor too. Pull the reviewed runtime child so the
# resulting archive is a portable, single-runtime Docker image.
"${docker_cmd[@]}" pull --platform linux/amd64 "$RUNTIME_SOURCE_REF" >/dev/null
image_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$RUNTIME_SOURCE_REF")
platform=$("${docker_cmd[@]}" image inspect --format '{{.Os}}/{{.Architecture}}' "$RUNTIME_SOURCE_REF")
image_id=${image_id//$'\r'/}
platform=${platform//$'\r'/}
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Pulled Mongo image has an invalid image ID.'
[[ $image_id == "$RUNTIME_MANIFEST_ID" ]] || die 'Pulled Mongo image differs from the reviewed runtime manifest.'
[[ $platform == 'linux/amd64' ]] || die "Pulled Mongo image platform is ${platform}, not linux/amd64."
repo_digests=$("${docker_cmd[@]}" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$RUNTIME_SOURCE_REF")
repo_digests=${repo_digests//$'\r'/}
grep -Fx 'mongo@sha256:76f1e3cc36f46a79f98f30736174fa0c55a2ba41d6ce860e4e551e3ffbcce009' <<< "$repo_digests" >/dev/null ||
  die 'Pulled Mongo image does not retain the reviewed runtime digest.'

existing_tag_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$ARCHIVE_REF" 2>/dev/null || true)
existing_tag_id=${existing_tag_id//$'\r'/}
[[ -z $existing_tag_id || $existing_tag_id == "$image_id" || $existing_tag_id == "$SOURCE_INDEX_ID" ]] ||
  die "Existing ${ARCHIVE_REF} tag is neither the reviewed source index nor runtime image."
"${docker_cmd[@]}" image tag "$RUNTIME_SOURCE_REF" "$ARCHIVE_REF"
archive_tag_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$ARCHIVE_REF")
archive_tag_id=${archive_tag_id//$'\r'/}
[[ $archive_tag_id == "$image_id" ]] ||
  die 'Offline Mongo archive tag does not resolve to the reviewed image.'

archive="${work_root}/${ARCHIVE_NAME}"
"${docker_cmd[@]}" image save "$ARCHIVE_REF" | gzip --best > "$archive"
[[ -s $archive ]] || die 'Mongo archive is empty.'
gzip --test -- "$archive"
identity="${work_root}/archive-identity.env"
python3 "$ARCHIVE_VERIFIER" \
  --archive "$archive" \
  --expected-ref "$ARCHIVE_REF" \
  --expected-id "$image_id" \
  --expected-attestation-id "$ATTESTATION_MANIFEST_ID" \
  --identity-output "$identity" \
  --require-portable-candidate
[[ $(grep -c '^CONFIG_IMAGE_ID=' "$identity") == '1' ]] || die 'Mongo archive verifier omitted its config identity.'
config_image_id=$(sed -n 's/^CONFIG_IMAGE_ID=//p' "$identity")
[[ $config_image_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Mongo archive config identity is invalid.'
python3 "$ARCHIVE_VERIFIER" \
  --archive "$archive" \
  --expected-ref "$ARCHIVE_REF" \
  --expected-id "$config_image_id" \
  --expected-config-id "$config_image_id" \
  --expected-attestation-id "$ATTESTATION_MANIFEST_ID" \
  --require-portable-candidate
rm -- "$identity"
archive_sha=$(sha256sum --binary "$archive" | awk '{print $1}')
printf '%s  %s\n' "$archive_sha" "$ARCHIVE_NAME" > "${archive}.sha256"
{
  printf 'format_version=1\n'
  printf 'source_ref=%s\n' "$SOURCE_REF"
  printf 'archive_ref=%s\n' "$ARCHIVE_REF"
  printf 'build_engine_image_id=%s\n' "$image_id"
  printf 'config_image_id=%s\n' "$config_image_id"
  printf 'archive_sha256=%s\n' "$archive_sha"
  printf 'created_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "${work_root}/mongo-image.env"
chmod 0600 -- "$work_root"/*
mv -- "$work_root" "$destination_absolute"
published=true
trap - EXIT INT TERM HUP
printf 'MongoDB 7.0.40 archive admission passed.\n'
printf '  archive=%s/%s\n' "$destination_absolute" "$ARCHIVE_NAME"
printf '  config_image_id=%s\n' "$config_image_id"
printf '  build_engine_image_id=%s\n' "$image_id"
printf '  source_ref=%s\n' "$SOURCE_REF"
printf '  archive_sha256=%s\n' "$archive_sha"
