#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
LC_ALL=C
export LC_ALL
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd -P)
readonly DEFAULT_OUTPUT_ROOT="${SCRIPT_DIR}/dist-v7-image"
readonly DEFAULT_REPOSITORY='local/titra'
readonly DEFAULT_BUILD_VARIANT='hardened1'
readonly ARCHIVE_VERIFIER="${SCRIPT_DIR}/security-v7/verify_docker_save_archive.py"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<EOF
Usage:
  $0 [--docker EXECUTABLE] [--output-root DIRECTORY] [--repository NAME]
     [--build-variant NAME]

Build and admit an immutable Linux/amd64 release candidate, save it as a gzip
Docker archive, and emit the reviewed nine-file evidence set. The Docker
executable defaults to \$DOCKER_BIN, then to "docker". A Windows Docker Desktop
CLI path exposed through WSL is supported, for example:

  $0 --docker '/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe'

The generated tag always contains the selected build variant ("hardened1" by
default),
the 12-character Git commit prefix, and the 12-character digest prefix of the
complete effective Docker build context. Existing output directories and
existing candidate tags are never replaced. Portable builds explicitly omit
attestations and bind both the build engine's tested image ID and the saved
config digest, allowing the same admitted archive on classic and containerd
Docker image stores.
EOF
}

docker_bin=${DOCKER_BIN:-docker}
output_root=$DEFAULT_OUTPUT_ROOT
repository=$DEFAULT_REPOSITORY
build_variant=${TITRA_BUILD_VARIANT:-$DEFAULT_BUILD_VARIANT}
while (( $# > 0 )); do
  case $1 in
    --docker)
      (( $# >= 2 )) || die '--docker requires an executable path or command name.'
      docker_bin=$2
      shift 2
      ;;
    --output-root)
      (( $# >= 2 )) || die '--output-root requires a directory.'
      output_root=$2
      shift 2
      ;;
    --repository)
      (( $# >= 2 )) || die '--repository requires a local Docker repository name.'
      repository=$2
      shift 2
      ;;
    --build-variant)
      (( $# >= 2 )) || die '--build-variant requires a release variant name.'
      build_variant=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown image-build argument: $1"
      ;;
  esac
done

[[ -n $docker_bin && $docker_bin != *$'\n'* && $docker_bin != *$'\r'* && $docker_bin != *$'\t'* ]] ||
  die 'Docker executable contains an invalid control character.'
[[ $repository =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
  die '--repository must be a lowercase Docker repository name without a tag or digest.'
[[ $build_variant =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  die '--build-variant must be a lowercase release variant name of at most 64 characters.'
[[ $output_root != *$'\n'* && $output_root != *$'\r'* && $output_root != *$'\t'* ]] ||
  die '--output-root contains an invalid control character.'

for command_name in awk cat cmp cp dirname git gzip mkdir mktemp mv python3 readlink rm sha256sum sort stat tr; do
  command -v -- "$command_name" >/dev/null 2>&1 || die "Required image-build command is unavailable: ${command_name}"
done
if [[ $docker_bin == */* ]]; then
  [[ -f $docker_bin && -x $docker_bin ]] || die "Docker executable is absent or not executable: ${docker_bin}"
else
  command -v -- "$docker_bin" >/dev/null 2>&1 || die "Docker executable is unavailable: ${docker_bin}"
fi
docker_cmd=("$docker_bin")
docker_source_root=$SOURCE_ROOT
docker_dockerfile="${SOURCE_ROOT}/Dockerfile"
if [[ $docker_bin == *.exe ]]; then
  command -v -- wslpath >/dev/null 2>&1 ||
    die 'A Windows Docker executable requires wslpath for host-path translation.'
  docker_source_root=$(wslpath -w -- "$SOURCE_ROOT") ||
    die 'Unable to translate the Docker build context for the Windows CLI.'
  docker_dockerfile=$(wslpath -w -- "${SOURCE_ROOT}/Dockerfile") ||
    die 'Unable to translate the Dockerfile path for the Windows CLI.'
fi

[[ -f ${SOURCE_ROOT}/Dockerfile && ! -L ${SOURCE_ROOT}/Dockerfile ]] || die 'Dockerfile is absent or unsafe.'
[[ -f ${SOURCE_ROOT}/.dockerignore && ! -L ${SOURCE_ROOT}/.dockerignore ]] || die '.dockerignore is absent or unsafe.'
[[ -f ${SOURCE_ROOT}/package.json && ! -L ${SOURCE_ROOT}/package.json ]] || die 'package.json is absent or unsafe.'
[[ -f $ARCHIVE_VERIFIER && ! -L $ARCHIVE_VERIFIER ]] ||
  die 'Offline Docker-save archive verifier is absent or unsafe.'

source_commit=$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || die 'Git HEAD is not a full lowercase SHA-1 object ID.'
version=$(python3 - "${SOURCE_ROOT}/package.json" <<'PY'
import json
import pathlib
import re
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("version")
if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,127}", value):
    raise SystemExit("package.json contains an unsafe or missing version")
if value.lower() in {"latest", "unknown", "uncommitted", "default"}:
    raise SystemExit("package.json version is not an immutable release label")
print(value)
PY
) || die 'Unable to obtain a safe package version.'

mkdir -p -- "$output_root"
output_root=$(readlink -f -- "$output_root") || die 'Cannot resolve the image output root.'
[[ -d $output_root && ! -L $output_root ]] || die 'Image output root is absent or unsafe.'
work_root=$(mktemp -d "${output_root}/.v7-image-build.XXXXXXXX")
tag_created=false
cleanup() {
  local resolved_work current_tag_id
  if [[ ${tag_created:-false} == true && -n ${candidate_ref:-} && -n ${image_id:-} ]]; then
    current_tag_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$candidate_ref" 2>/dev/null || true)
    current_tag_id=${current_tag_id//$'\r'/}
    if [[ $current_tag_id == "$image_id" ]]; then
      "${docker_cmd[@]}" image rm "$candidate_ref" >/dev/null 2>&1 || true
    fi
  fi
  resolved_work=$(readlink -f -- "$work_root" 2>/dev/null || true)
  if [[ -n $resolved_work && $resolved_work == "${output_root}/.v7-image-build."* && -d $resolved_work ]]; then
    rm -rf --one-file-system -- "$resolved_work"
  fi
}
trap cleanup EXIT INT TERM HUP
evidence_dir="${work_root}/evidence"
mkdir -m 0700 -- "$evidence_dir"

write_context_manifest() {
  local destination=$1
  python3 - "$SOURCE_ROOT" "$destination" <<'PY'
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
destination = Path(sys.argv[2])

# This is deliberately exact. If .dockerignore changes, the builder stops until
# its context enumerator and review are changed in the same patch.
expected_rules = [
    "*",
    "!Dockerfile",
    "!.dockerignore",
    "!entrypoint.sh",
    "!package.json",
    "!package-lock.json",
    "!rspack.config.js",
    "!deployment/",
    "deployment/*",
    "!deployment/security-v7/",
    "deployment/security-v7/*",
    "!deployment/security-v7/eslint-build.config.mjs",
    "!deployment/security-v7/remove-bundled-vulnerabilities.mjs",
    "!deployment/security-v7/runtime/",
    "!deployment/security-v7/runtime/**",
    "!public/",
    "!public/**",
    "!server/",
    "!server/**",
    "!client/",
    "!client/**",
    "!imports/",
    "!imports/**",
    "!.meteor/",
    "!.meteor/**",
    ".meteor/local/",
    ".meteor/local/**",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/*.jks",
    "**/secrets/",
    "**/secrets/**",
    "**/credentials/",
    "**/credentials/**",
]
dockerignore = root / ".dockerignore"
actual_rules = [
    line.strip()
    for line in dockerignore.read_text(encoding="utf-8").splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
if actual_rules != expected_rules:
    raise SystemExit(
        ".dockerignore differs from the reviewed allowlist; update and review "
        "the build-context enumerator before building"
    )

top_files = [
    ".dockerignore",
    "Dockerfile",
    "deployment/security-v7/eslint-build.config.mjs",
    "deployment/security-v7/remove-bundled-vulnerabilities.mjs",
    "entrypoint.sh",
    "package-lock.json",
    "package.json",
    "rspack.config.js",
]
source_roots = [
    ".meteor",
    "client",
    "deployment/security-v7/runtime",
    "imports",
    "public",
    "server",
]
sensitive_suffixes = (".pem", ".key", ".p12", ".pfx", ".jks")


def excluded(relative: str, is_directory: bool) -> bool:
    parts = relative.split("/")
    if (
        len(parts) >= 2
        and parts[0] == ".meteor"
        and parts[1] == "local"
        and (len(parts) > 2 or is_directory)
    ):
        return True
    if any(part in {"secrets", "credentials"} for part in parts[:-1]):
        return True
    if is_directory and parts[-1] in {"secrets", "credentials"}:
        return True
    name = parts[-1]
    if name == ".env" or name.startswith(".env."):
        return True
    if not is_directory and name.endswith(sensitive_suffixes):
        return True
    return False


def looks_sensitive(relative: str) -> bool:
    parts = relative.split("/")
    names = [part.lower() for part in parts]
    name = names[-1]
    return (
        (len(names) >= 2 and names[0] == ".meteor" and names[1] == "local")
        or any(part in {"secrets", "credentials"} for part in names)
        or name == ".env"
        or name.startswith(".env.")
        or name.endswith(sensitive_suffixes)
    )


def validate_path(relative: str) -> None:
    if not relative or relative.startswith("/") or "\\" in relative:
        raise SystemExit(f"unsafe build-context path: {relative!r}")
    if any(ord(character) < 32 or ord(character) == 127 for character in relative):
        raise SystemExit(f"control character in build-context path: {relative!r}")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        raise SystemExit(f"non-canonical build-context path: {relative!r}")


def stable_file_digest(path: Path, first: os.stat_result) -> tuple[int, str]:
    flags = os.O_RDONLY
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (first.st_dev, first.st_ino):
            raise SystemExit(f"build-context file changed before it was opened: {path}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        final_open = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    final_path = path.lstat()
    identity = lambda value: (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )
    if identity(opened) != identity(final_open) or identity(opened) != identity(final_path):
        raise SystemExit(f"build-context file changed while it was hashed: {path}")
    return opened.st_size, digest.hexdigest()


entries: list[tuple[str, str, int, str, str]] = []


def add(relative: str) -> None:
    validate_path(relative)
    path = root / relative
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"symlinks are not admitted to the Docker context: {relative}")
    mode = f"{stat.S_IMODE(metadata.st_mode):04o}"
    if stat.S_ISREG(metadata.st_mode):
        size, digest = stable_file_digest(path, metadata)
        entries.append((relative, "file", size, digest, mode))
        return
    if not stat.S_ISDIR(metadata.st_mode):
        raise SystemExit(f"special object is not admitted to the Docker context: {relative}")
    entries.append((relative + "/", "directory", 0, "-", mode))
    children = sorted(os.scandir(path), key=lambda item: os.fsencode(item.name))
    for child in children:
        child_relative = f"{relative}/{child.name}"
        child_metadata = child.stat(follow_symlinks=False)
        child_is_directory = stat.S_ISDIR(child_metadata.st_mode)
        if excluded(child_relative, child_is_directory):
            continue
        if looks_sensitive(child_relative):
            raise SystemExit(
                "credential-like path is not covered exactly by .dockerignore: "
                f"{child_relative}"
            )
        add(child_relative)


for relative in top_files:
    add(relative)
for relative in source_roots:
    add(relative)

entries.sort(key=lambda item: os.fsencode(item[0]))
with destination.open("wb") as stream:
    stream.write(b"titra-docker-build-context-v1\n")
    for relative, kind, size, digest, mode in entries:
        stream.write(
            f"{kind}\t{mode}\t{size}\t{digest}\t{relative}\n".encode("utf-8")
        )
PY
}

pre_manifest="${evidence_dir}/build-context.manifest"
write_context_manifest "$pre_manifest"
source_context_sha=$(sha256sum -- "$pre_manifest" | awk '{print $1}')
[[ $source_context_sha =~ ^[0-9a-f]{64}$ ]] || die 'Build-context digest is invalid.'
printf '%s  build-context.manifest\n' "$source_context_sha" > "${evidence_dir}/build-context.sha256"
meteor_versions_snapshot="${work_root}/meteor.versions.snapshot"
cp -- "${SOURCE_ROOT}/.meteor/versions" "$meteor_versions_snapshot"
expected_meteor_versions_sha=$(awk -F $'\t' '$5 == ".meteor/versions" {print $4}' "$pre_manifest")
[[ $expected_meteor_versions_sha =~ ^[0-9a-f]{64}$ ]] ||
  die 'The build-context manifest does not contain exactly one valid .meteor/versions digest.'
[[ $(sha256sum -- "$meteor_versions_snapshot" | awk '{print $1}') == "$expected_meteor_versions_sha" ]] ||
  die '.meteor/versions changed while its build evidence was captured.'

short_commit=${source_commit:0:12}
short_context=${source_context_sha:0:12}
identity="${version}-${short_commit}-ctx${short_context}-${build_variant}-amd64"
candidate_ref="${repository}:${identity}"
[[ $candidate_ref != *:latest ]] || die 'The latest Docker tag is never permitted.'
final_root="${output_root}/${identity}"
[[ ! -e $final_root ]] || die "Image-build output already exists and will not be replaced: ${final_root}"

if existing_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$candidate_ref" 2>/dev/null); then
  existing_id=${existing_id//$'\r'/}
  die "Candidate tag already exists and will not be replaced: ${candidate_ref} (${existing_id})"
fi
"${docker_cmd[@]}" version >/dev/null

printf 'Building release candidate from source context %s...\n' "$source_context_sha"
build_output=$("${docker_cmd[@]}" build \
  --pull=false \
  --platform=linux/amd64 \
  --provenance=false \
  --sbom=false \
  --quiet \
  --file "$docker_dockerfile" \
  --build-arg "TITRA_VERSION=${version}" \
  --build-arg "VCS_REF=${source_commit}" \
  --build-arg "SOURCE_CONTEXT_SHA256=${source_context_sha}" \
  "$docker_source_root") || die 'Docker failed to build the release candidate.'
build_output=${build_output//$'\r'/}
mapfile -t build_lines < <(printf '%s\n' "$build_output" | awk 'NF')
(( ${#build_lines[@]} == 1 )) || die 'Docker quiet build returned unexpected standard output.'
image_id=${build_lines[0]}
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Docker build did not return one valid image ID.'

post_manifest="${work_root}/build-context.after.manifest"
write_context_manifest "$post_manifest"
post_context_sha=$(sha256sum -- "$post_manifest" | awk '{print $1}')
[[ $post_context_sha == "$source_context_sha" ]] ||
  die 'Docker build context changed while the image was being built; the untagged image is not admitted.'
cmp --silent "$pre_manifest" "$post_manifest" ||
  die 'Docker build-context manifest changed without a digest change; the untagged image is not admitted.'
post_source_commit=$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)
[[ $post_source_commit == "$source_commit" ]] ||
  die 'Git HEAD changed while the image was being built; the untagged image is not admitted.'
rm -- "$post_manifest"

raw_inspect="${work_root}/image-inspect.raw.json"
"${docker_cmd[@]}" image inspect "$image_id" > "$raw_inspect"
python3 - "$raw_inspect" "${evidence_dir}/image-inspect.json" \
  "$image_id" "$version" \
  "$source_commit" "$source_context_sha" <<'PY'
import json
from pathlib import Path
import re
import sys

(
    source_path,
    canonical_path,
    expected_id,
    version,
    source_commit,
    source_context_sha,
) = sys.argv[1:]

documents = json.loads(Path(source_path).read_text(encoding="utf-8"))
if not isinstance(documents, list) or len(documents) != 1 or not isinstance(documents[0], dict):
    raise SystemExit("Docker image inspect did not return exactly one object")
image = documents[0]
config = image.get("Config")
if not isinstance(config, dict):
    raise SystemExit("Docker image inspect omitted Config")

expected_health_code = (
    "const http=require('http');const req=http.get({host:'127.0.0.1',"
    "port:process.env.PORT||3000,path:'/'},res=>{res.resume();"
    "process.exit(res.statusCode<500?0:1)});req.setTimeout(4000,()=>req.destroy());"
    "req.on('error',()=>process.exit(1));"
)
expected_health = {
    "Test": ["CMD", "node", "-e", expected_health_code],
    "Interval": 30_000_000_000,
    "Timeout": 5_000_000_000,
    "StartPeriod": 30_000_000_000,
    "Retries": 3,
}
required_labels = {
    "org.opencontainers.image.title": "titra",
    "org.opencontainers.image.source": "https://github.com/titraio/titra",
    "org.opencontainers.image.licenses": "GPL-3.0-only",
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": source_commit,
    "io.titra.source-context.sha256": source_context_sha,
}

checks = [
    (image.get("Id") == expected_id, "image ID"),
    (image.get("Os") == "linux", "operating system"),
    (image.get("Architecture") == "amd64", "architecture"),
    (config.get("User") == "node", "runtime user"),
    (config.get("Entrypoint") == ["/docker/entrypoint.sh"], "entrypoint"),
    (config.get("Cmd") == ["node", "bundle/main.js"], "command"),
    (config.get("Healthcheck") == expected_health, "health check"),
]
for passed, description in checks:
    if not passed:
        raise SystemExit(f"candidate failed image admission: unexpected {description}")

labels = config.get("Labels") or {}
if not isinstance(labels, dict):
    raise SystemExit("candidate failed image admission: labels are malformed")
for key, value in required_labels.items():
    if labels.get(key) != value:
        raise SystemExit(f"candidate failed image admission: label {key} is absent or incorrect")

environment = config.get("Env") or []
if not isinstance(environment, list) or not all(isinstance(item, str) for item in environment):
    raise SystemExit("candidate failed image admission: environment is malformed")
names = []
values = {}
for item in environment:
    name, separator, value = item.partition("=")
    if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise SystemExit("candidate failed image admission: malformed environment entry")
    if name in values:
        raise SystemExit(f"candidate failed image admission: duplicate environment name {name}")
    names.append(name)
    values[name] = value
credential_pattern = re.compile(
    r"password|passwd|secret|token|api_?key|credential|private_?key|access_?key|auth",
    re.IGNORECASE,
)
credential_names = sorted(name for name in names if credential_pattern.search(name))
if credential_names:
    # Names alone are safe to report; values are deliberately never included.
    raise SystemExit(
        "candidate failed image admission: credential-like environment name(s): "
        + ", ".join(credential_names)
    )
if values.get("PORT") != "3000" or values.get("NODE_ENV") != "production":
    raise SystemExit("candidate failed image admission: expected runtime environment is absent")

Path(canonical_path).write_text(
    json.dumps(documents, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
    newline="\n",
)
PY
rm -- "$raw_inspect"

"${docker_cmd[@]}" image tag "$image_id" "$candidate_ref"
tag_created=true
tagged_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$candidate_ref")
tagged_id=${tagged_id//$'\r'/}
[[ $tagged_id == "$image_id" ]] || die 'Candidate tag does not resolve to the admitted image ID.'
tagged_inspect="${work_root}/image-inspect.tagged.json"
"${docker_cmd[@]}" image inspect "$candidate_ref" > "$tagged_inspect"
python3 - "$tagged_inspect" "${evidence_dir}/image-inspect.json" "$candidate_ref" "$image_id" <<'PY'
import json
from pathlib import Path
import sys

source, destination, expected_ref, expected_id = sys.argv[1:]
documents = json.loads(Path(source).read_text(encoding="utf-8"))
if (
    not isinstance(documents, list)
    or len(documents) != 1
    or documents[0].get("Id") != expected_id
    or expected_ref not in (documents[0].get("RepoTags") or [])
):
    raise SystemExit("tagged image inspection does not match the admitted ID/reference")
Path(destination).write_text(
    json.dumps(documents, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
    newline="\n",
)
PY
rm -- "$tagged_inspect"

"${docker_cmd[@]}" image history --no-trunc --format '{{json .}}' "$image_id" |
  tr -d '\r' > "${evidence_dir}/image-history.txt"
[[ -s ${evidence_dir}/image-history.txt ]] || die 'Docker image history evidence is empty.'

"${docker_cmd[@]}" run --rm --network=none --entrypoint /sbin/apk "$image_id" info -vv |
  tr -d '\r' | sort -u > "${evidence_dir}/runtime-os-packages.txt"
[[ -s ${evidence_dir}/runtime-os-packages.txt ]] || die 'Runtime operating-system inventory is empty.'

# JavaScript template literals must remain literal Bash data.
# shellcheck disable=SC2016
node_inventory_program='const fs=require("fs"),path=require("path");const rows=[];const meteorRoot="/app/bundle/programs/server/npm/node_modules/meteor";const order=(entries)=>entries.sort((a,b)=>Buffer.from(a.name).compare(Buffer.from(b.name)));const visitModules=(root)=>{if(!fs.existsSync(root))return;for(const entry of order(fs.readdirSync(root,{withFileTypes:true}))){if(entry.name===".bin"||!entry.isDirectory())continue;const full=path.join(root,entry.name);if(entry.name.startsWith("@")){for(const scoped of order(fs.readdirSync(full,{withFileTypes:true})))if(scoped.isDirectory())visitPackage(path.join(full,scoped.name));}else visitPackage(full);}};const visitPackage=(root)=>{const manifest=path.join(root,"package.json");if(!fs.existsSync(manifest)){if(root===meteorRoot){for(const entry of order(fs.readdirSync(root,{withFileTypes:true})))if(entry.isDirectory())visitPackage(path.join(root,entry.name));return;}if(root.startsWith(`${meteorRoot}/`)){visitModules(path.join(root,"node_modules"));return;}throw new Error(`cannot inventory non-package directory ${root}`);}let data;try{data=JSON.parse(fs.readFileSync(manifest,"utf8"));}catch(error){throw new Error(`cannot inventory ${root}: ${error.message}`);}if(typeof data.name!=="string"||typeof data.version!=="string")throw new Error(`invalid package identity in ${root}`);rows.push(`${data.name}@${data.version}\t${root.replace(/^\/app\/bundle\//,"")}`);visitModules(path.join(root,"node_modules"));};visitModules("/app/bundle/programs/server/node_modules");visitModules("/app/bundle/programs/server/npm/node_modules");process.stdout.write([...new Set(rows)].sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).join("\n")+"\n");'
"${docker_cmd[@]}" run --rm --network=none --entrypoint node "$image_id" \
  -e "$node_inventory_program" | tr -d '\r' | sort -u > "${evidence_dir}/runtime-node-packages.txt"
[[ -s ${evidence_dir}/runtime-node-packages.txt ]] || die 'Runtime Node package inventory is empty.'

LC_ALL=C sort -u -- "$meteor_versions_snapshot" > "${evidence_dir}/meteor-packages.txt"
[[ -s ${evidence_dir}/meteor-packages.txt ]] || die 'Meteor package inventory is empty.'
rm -- "$meteor_versions_snapshot"

archive_name="titra-v7-${identity}-linux-amd64.tar.gz"
archive_path="${work_root}/${archive_name}"
"${docker_cmd[@]}" image save "$candidate_ref" | gzip --best > "$archive_path"
gzip --test -- "$archive_path"
post_save_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$candidate_ref")
post_save_id=${post_save_id//$'\r'/}
[[ $post_save_id == "$image_id" ]] ||
  die 'Candidate image identity changed while its Docker archive was saved.'
archive_identity="${work_root}/archive-identity.env"
python3 "$ARCHIVE_VERIFIER" \
  --archive "$archive_path" \
  --expected-ref "$candidate_ref" \
  --expected-id "$image_id" \
  --expected-source-context "$source_context_sha" \
  --expected-source-commit "$source_commit" \
  --expected-version "$version" \
  --expected-build-variant "$build_variant" \
  --require-portable-candidate \
  --identity-output "$archive_identity"
config_image_id=$(python3 - "$archive_identity" "$image_id" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
expected_tested_id = sys.argv[2]
raw = path.read_text(encoding="utf-8")
if not raw.endswith("\n") or "\r" in raw:
    raise SystemExit("archive identity record is not canonical LF-terminated text")
records = {}
keys = []
for line in raw.splitlines():
    if "=" not in line:
        raise SystemExit("archive identity record is malformed")
    key, value = line.split("=", 1)
    if key in records:
        raise SystemExit("archive identity record contains a duplicate key")
    keys.append(key)
    records[key] = value
if keys != ["FORMAT_VERSION", "TESTED_IMAGE_ID", "CONFIG_IMAGE_ID"]:
    raise SystemExit("archive identity record schema/order is unexpected")
if records["FORMAT_VERSION"] != "1":
    raise SystemExit("archive identity record format is unsupported")
if records["TESTED_IMAGE_ID"] != expected_tested_id:
    raise SystemExit("archive identity record changed the tested image ID")
if re.fullmatch(r"sha256:[0-9a-f]{64}", records["CONFIG_IMAGE_ID"]) is None:
    raise SystemExit("archive identity record has an invalid config image ID")
print(records["CONFIG_IMAGE_ID"])
PY
) || die 'Unable to read the verified archive identity record.'
rm -- "$archive_identity"

{
  printf 'FORMAT_VERSION=2\n'
  printf 'IMAGE_REF=%s\n' "$candidate_ref"
  printf 'IMAGE_ID=%s\n' "$image_id"
  printf 'CONFIG_IMAGE_ID=%s\n' "$config_image_id"
  printf 'IMAGE_OS=linux\n'
  printf 'IMAGE_ARCH=amd64\n'
  printf 'IMAGE_USER=node\n'
  printf 'IMAGE_ENTRYPOINT_JSON=["/docker/entrypoint.sh"]\n'
  printf 'IMAGE_CMD_JSON=["node","bundle/main.js"]\n'
  printf 'IMAGE_HEALTHCHECK_PRESENT=true\n'
  printf 'SOURCE_COMMIT=%s\n' "$source_commit"
  printf 'SOURCE_CONTEXT_SHA256=%s\n' "$source_context_sha"
  printf 'CREDENTIAL_ENV_NAME_COUNT=0\n'
} > "${evidence_dir}/admission.env"

evidence_files=(
  'admission.env'
  'build-context.manifest'
  'build-context.sha256'
  'image-history.txt'
  'image-inspect.json'
  'meteor-packages.txt'
  'runtime-node-packages.txt'
  'runtime-os-packages.txt'
)
(
  cd -- "$evidence_dir"
  for evidence_file in "${evidence_files[@]}"; do
    sha256sum -- "$evidence_file"
  done
) > "${evidence_dir}/SHA256SUMS"
(
  cd -- "$evidence_dir"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
archive_sha=$(sha256sum -- "$archive_path" | awk '{print $1}')
archive_bytes=$(stat -c '%s' -- "$archive_path")
printf '%s  %s\n' "$archive_sha" "$archive_name" > "${archive_path}.sha256"
evidence_sha=$(sha256sum -- "${evidence_dir}/SHA256SUMS" | awk '{print $1}')

final_evidence_dir="${final_root}/evidence"
final_archive_path="${final_root}/${archive_name}"
cat > "${work_root}/build-result.env" <<EOF
FORMAT_VERSION=3
BUILD_VARIANT=${build_variant}
IMAGE_REF=${candidate_ref}
IMAGE_ID=${image_id}
CONFIG_IMAGE_ID=${config_image_id}
SOURCE_COMMIT=${source_commit}
SOURCE_CONTEXT_SHA256=${source_context_sha}
CANDIDATE_ARCHIVE=${final_archive_path}
CANDIDATE_ARCHIVE_SHA256=${archive_sha}
CANDIDATE_ARCHIVE_BYTES=${archive_bytes}
IMAGE_EVIDENCE_DIR=${final_evidence_dir}
EVIDENCE_SHA256SUMS_SHA256=${evidence_sha}
EOF

mv -- "$work_root" "$final_root"
tag_created=false
trap - EXIT INT TERM HUP

printf 'Image build and admission passed.\n'
printf '  output_directory=%s\n' "$final_root"
printf '  build_variant=%s\n' "$build_variant"
printf '  image_ref=%s\n' "$candidate_ref"
printf '  image_id=%s\n' "$image_id"
printf '  config_image_id=%s\n' "$config_image_id"
printf '  source_commit=%s\n' "$source_commit"
printf '  source_context_sha256=%s\n' "$source_context_sha"
printf '  candidate_archive=%s\n' "$final_archive_path"
printf '  candidate_archive_sha256=%s\n' "$archive_sha"
printf '  candidate_archive_bytes=%s\n' "$archive_bytes"
printf '  image_evidence_dir=%s\n' "$final_evidence_dir"
printf '  evidence_sha256sums_sha256=%s\n' "$evidence_sha"
