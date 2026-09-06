#!/usr/bin/env python3

"""Offline structural and content-address verification for Docker save archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MAX_METADATA_BYTES = 32 * 1024 * 1024
DIGEST = re.compile(r"sha256:([0-9a-f]{64})")
BLOB_PATH = re.compile(r"blobs/sha256/([0-9a-f]{64})")
LEGACY_CONFIG = re.compile(r"([0-9a-f]{64})\.json")
INDEX_MEDIA_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_MEDIA_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
CONFIG_MEDIA_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}


class VerificationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArchiveIdentity:
    layout: str
    tested_image_id: str
    config_image_id: str
    root_image_id: str
    manifest_image_id: str


def checked_digest(value: object, description: str) -> str:
    if not isinstance(value, str) or DIGEST.fullmatch(value) is None:
        raise VerificationError(f"{description} is not a sha256 digest")
    return value


def checked_json(raw: bytes | None, description: str) -> object:
    if raw is None:
        raise VerificationError(f"{description} is absent or unreasonably large")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{description} is not valid UTF-8 JSON") from error


def checked_member_name(name: str, is_directory: bool) -> str:
    if (
        not name
        or "\\" in name
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
    ):
        raise VerificationError("archive contains an unsafe member name")
    canonical = name[:-1] if is_directory and name.endswith("/") else name
    path = PurePosixPath(canonical)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in ("", ".", "..") for part in path.parts)
        or str(path) != canonical
    ):
        raise VerificationError("archive contains a non-canonical member name")
    return name


def scan_archive(
    path: Path,
) -> tuple[dict[str, tuple[int, bytes | None]], dict[str, bytes], set[str]]:
    blobs: dict[str, tuple[int, bytes | None]] = {}
    metadata: dict[str, bytes] = {}
    members: set[str] = set()
    try:
        archive = tarfile.open(path, mode="r|gz")  # noqa: SIM115 - closed in finally below
    except (OSError, tarfile.TarError) as error:
        raise VerificationError("archive is not a readable gzip tar stream") from error
    try:
        for member in archive:
            checked_member_name(member.name, member.isdir())
            if member.name in members:
                raise VerificationError(
                    f"archive contains duplicate member: {member.name}"
                )
            members.add(member.name)
            if member.isdir():
                continue
            if not member.isfile():
                raise VerificationError(
                    f"archive contains a link or special object: {member.name}"
                )
            stream = archive.extractfile(member)
            if stream is None:
                raise VerificationError(f"archive member cannot be read: {member.name}")
            blob_match = BLOB_PATH.fullmatch(member.name)
            retain = member.size <= MAX_METADATA_BYTES and (
                blob_match is not None
                or member.name in {"manifest.json", "index.json", "oci-layout"}
                or LEGACY_CONFIG.fullmatch(member.name) is not None
            )
            digest = hashlib.sha256() if blob_match is not None else None
            chunks: list[bytes] | None = [] if retain else None
            count = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                if digest is not None:
                    digest.update(chunk)
                if chunks is not None:
                    chunks.append(chunk)
            if count != member.size:
                raise VerificationError(
                    f"archive member size changed while reading: {member.name}"
                )
            content = b"".join(chunks) if chunks is not None else None
            if blob_match is not None:
                if digest is None or digest.hexdigest() != blob_match.group(1):
                    raise VerificationError(
                        f"content-addressed blob digest mismatch: {member.name}"
                    )
                blobs[member.name] = (member.size, content)
            elif content is not None:
                metadata[member.name] = content
    except (OSError, tarfile.TarError) as error:
        raise VerificationError("archive failed while its members were read") from error
    finally:
        archive.close()
    return blobs, metadata, members


def descriptor_record(
    descriptor: object,
    blobs: dict[str, tuple[int, bytes | None]],
    description: str,
) -> tuple[str, bytes | None]:
    if not isinstance(descriptor, dict):
        raise VerificationError(f"{description} descriptor is malformed")
    digest = checked_digest(descriptor.get("digest"), f"{description} digest")
    size = descriptor.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise VerificationError(f"{description} size is malformed")
    path = f"blobs/sha256/{digest.removeprefix('sha256:')}"
    record = blobs.get(path)
    if record is None or record[0] != size:
        raise VerificationError(f"{description} blob is absent or has the wrong size")
    return digest, record[1]


def descriptor_blob(
    descriptor: object,
    blobs: dict[str, tuple[int, bytes | None]],
    description: str,
) -> tuple[str, object]:
    digest, raw = descriptor_record(descriptor, blobs, description)
    return digest, checked_json(raw, f"{description} blob")


def select_image_manifest(
    root_descriptor: dict[str, object],
    blobs: dict[str, tuple[int, bytes | None]],
    require_portable_candidate: bool,
) -> tuple[str, str, dict[str, object]]:
    root_annotations = root_descriptor.get("annotations")
    if (
        require_portable_candidate
        and isinstance(root_annotations, dict)
        and root_annotations.get("vnd.docker.reference.type") == "attestation-manifest"
    ):
        raise VerificationError(
            "portable candidate OCI index contains an attestation descriptor"
        )
    root_digest, root = descriptor_blob(root_descriptor, blobs, "root image")
    if not isinstance(root, dict) or root.get("schemaVersion") != 2:
        raise VerificationError(
            "root image descriptor does not reference a schema-2 object"
        )
    media_type = root.get("mediaType") or root_descriptor.get("mediaType")
    if media_type in MANIFEST_MEDIA_TYPES:
        return root_digest, root_digest, root
    if media_type not in INDEX_MEDIA_TYPES:
        raise VerificationError("root image descriptor has an unsupported media type")
    descriptors = root.get("manifests")
    if not isinstance(descriptors, list):
        raise VerificationError("root image index omits its manifests")
    if require_portable_candidate:
        if len(descriptors) != 1:
            raise VerificationError(
                "portable candidate root index contains an attestation or additional manifest"
            )
        descriptor = descriptors[0]
        annotations = (
            descriptor.get("annotations") if isinstance(descriptor, dict) else None
        )
        if (
            isinstance(annotations, dict)
            and annotations.get("vnd.docker.reference.type") == "attestation-manifest"
        ):
            raise VerificationError(
                "portable candidate root index contains an attestation descriptor"
            )
    candidates = []
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            raise VerificationError("root image index contains a malformed descriptor")
        platform = descriptor.get("platform") or {}
        if (
            descriptor.get("mediaType") in MANIFEST_MEDIA_TYPES
            and isinstance(platform, dict)
            and platform.get("os") == "linux"
            and platform.get("architecture") == "amd64"
        ):
            candidates.append(descriptor)
    if len(candidates) != 1:
        raise VerificationError(
            "root image index does not contain exactly one linux/amd64 image manifest"
        )
    manifest_digest, selected = descriptor_blob(
        candidates[0], blobs, "linux/amd64 image manifest"
    )
    if not isinstance(selected, dict) or selected.get("schemaVersion") != 2:
        raise VerificationError("selected image manifest is malformed")
    return root_digest, manifest_digest, selected


def select_outer_root_descriptor(
    descriptors: object,
    blobs: dict[str, tuple[int, bytes | None]],
    expected_attestation_id: str | None,
) -> dict[str, object]:
    if not isinstance(descriptors, list):
        raise VerificationError("OCI index.json omits its saved image references")
    if expected_attestation_id is None:
        if len(descriptors) != 1 or not isinstance(descriptors[0], dict):
            raise VerificationError(
                "OCI index.json must contain exactly one saved image reference"
            )
        return descriptors[0]

    checked_digest(expected_attestation_id, "expected attestation manifest ID")
    if len(descriptors) != 2 or not all(
        isinstance(descriptor, dict) for descriptor in descriptors
    ):
        raise VerificationError(
            "OCI index.json must contain one runtime and one reviewed attestation"
        )
    attestation = next(
        (
            descriptor
            for descriptor in descriptors
            if descriptor.get("digest") == expected_attestation_id
        ),
        None,
    )
    roots = [
        descriptor
        for descriptor in descriptors
        if descriptor.get("digest") != expected_attestation_id
    ]
    if attestation is None or len(roots) != 1:
        raise VerificationError("reviewed OCI attestation descriptor is absent")
    root = roots[0]
    root_digest = checked_digest(root.get("digest"), "runtime root digest")
    if attestation.get("mediaType") not in MANIFEST_MEDIA_TYPES:
        raise VerificationError("reviewed OCI attestation media type is invalid")
    if attestation.get("platform") is not None:
        raise VerificationError("reviewed OCI attestation unexpectedly has a platform")
    if attestation.get("annotations") != {
        "io.containerd.manifest.subject": root_digest
    }:
        raise VerificationError("reviewed OCI attestation is not bound to the runtime")
    _, document = descriptor_blob(attestation, blobs, "reviewed attestation manifest")
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != 2
        or document.get("mediaType") not in MANIFEST_MEDIA_TYPES
    ):
        raise VerificationError("reviewed OCI attestation manifest is malformed")
    descriptor_record(document.get("config"), blobs, "attestation config")
    layers = document.get("layers")
    if not isinstance(layers, list) or not layers:
        raise VerificationError("reviewed OCI attestation has no statement layers")
    for number, layer in enumerate(layers):
        if (
            not isinstance(layer, dict)
            or layer.get("mediaType") != "application/vnd.in-toto+json"
        ):
            raise VerificationError(
                "reviewed OCI attestation layer is not in-toto JSON"
            )
        descriptor_record(layer, blobs, f"attestation layer {number}")
    return root


def validate_candidate_runtime(
    config: dict[str, object],
    expected_context: str,
    expected_commit: str,
    expected_version: str,
) -> None:
    runtime = config.get("config") or config.get("Config") or {}
    if not isinstance(runtime, dict):
        raise VerificationError("candidate runtime config is malformed")
    if runtime.get("User") != "node":
        raise VerificationError("candidate archive runtime user is not node")
    if runtime.get("Entrypoint") != ["/docker/entrypoint.sh"]:
        raise VerificationError("candidate archive entrypoint differs from admission")
    if runtime.get("Cmd") != ["node", "bundle/main.js"]:
        raise VerificationError("candidate archive command differs from admission")
    health = runtime.get("Healthcheck") or {}
    if (
        not isinstance(health, dict)
        or not isinstance(health.get("Test"), list)
        or not health["Test"]
    ):
        raise VerificationError("candidate archive has no health check")
    labels = runtime.get("Labels") or {}
    required_labels = {
        "org.opencontainers.image.title": "titra",
        "org.opencontainers.image.source": "https://github.com/titraio/titra",
        "org.opencontainers.image.licenses": "GPL-3.0-only",
        "org.opencontainers.image.version": expected_version,
        "org.opencontainers.image.revision": expected_commit,
        "io.titra.source-context.sha256": expected_context,
    }
    if not isinstance(labels, dict) or any(
        labels.get(key) != value for key, value in required_labels.items()
    ):
        raise VerificationError(
            "candidate archive provenance labels differ from the release"
        )


def verify_archive(
    archive_path: Path,
    expected_ref: str,
    expected_id: str,
    expected_context: str | None = None,
    expected_commit: str | None = None,
    expected_version: str | None = None,
    require_portable_candidate: bool = False,
    expected_config_id: str | None = None,
    expected_build_variant: str | None = None,
    expected_attestation_id: str | None = None,
) -> ArchiveIdentity:
    checked_digest(expected_id, "expected image ID")
    if expected_config_id is not None:
        checked_digest(expected_config_id, "expected config image ID")
    if expected_attestation_id is not None:
        checked_digest(expected_attestation_id, "expected attestation manifest ID")
    blobs, metadata, members = scan_archive(archive_path)
    docker_manifest = checked_json(
        metadata.get("manifest.json"), "Docker manifest.json"
    )
    if not isinstance(docker_manifest, list) or len(docker_manifest) != 1:
        raise VerificationError("Docker manifest.json must contain exactly one image")
    docker_record = docker_manifest[0]
    if not isinstance(docker_record, dict):
        raise VerificationError("Docker manifest.json image record is malformed")
    if expected_ref not in (docker_record.get("RepoTags") or []):
        raise VerificationError(
            "expected Docker reference is absent from manifest.json"
        )
    config_path = docker_record.get("Config")
    layers = docker_record.get("Layers")
    if (
        not isinstance(config_path, str)
        or not isinstance(layers, list)
        or not all(isinstance(item, str) for item in layers)
    ):
        raise VerificationError("Docker manifest.json config or layers are malformed")

    oci_config = BLOB_PATH.fullmatch(config_path)
    if oci_config is not None:
        layout = checked_json(metadata.get("oci-layout"), "OCI layout marker")
        if layout != {"imageLayoutVersion": "1.0.0"}:
            raise VerificationError("OCI layout marker is absent or unsupported")
        index = checked_json(metadata.get("index.json"), "OCI index.json")
        if not isinstance(index, dict) or index.get("schemaVersion") != 2:
            raise VerificationError("OCI index.json is malformed")
        root_descriptor = select_outer_root_descriptor(
            index.get("manifests"), blobs, expected_attestation_id
        )
        root_digest, manifest_digest, image_manifest = select_image_manifest(
            root_descriptor, blobs, require_portable_candidate
        )
        config_descriptor = image_manifest.get("config")
        config_digest, config_object = descriptor_blob(
            config_descriptor, blobs, "image config"
        )
        if not isinstance(config_object, dict):
            raise VerificationError("image config is not a JSON object")
        if config_path != f"blobs/sha256/{config_digest.removeprefix('sha256:')}":
            raise VerificationError(
                "manifest.json config differs from the OCI image manifest"
            )
        layer_descriptors = image_manifest.get("layers")
        if not isinstance(layer_descriptors, list):
            raise VerificationError("OCI image manifest omits layers")
        descriptor_paths = []
        for index_number, descriptor in enumerate(layer_descriptors):
            digest, _ = descriptor_record(
                descriptor, blobs, f"image layer {index_number}"
            )
            descriptor_paths.append(f"blobs/sha256/{digest.removeprefix('sha256:')}")
        if descriptor_paths != layers:
            raise VerificationError(
                "manifest.json layers differ from the OCI image manifest"
            )
        # Python's tar reader normalizes directory member names by dropping the
        # archive's trailing slash, while command-line tar commonly displays it.
        allowed = {
            "manifest.json",
            "index.json",
            "oci-layout",
            "blobs",
            "blobs/sha256",
            *blobs.keys(),
        }
        if members != allowed:
            raise VerificationError(
                "OCI archive contains an unexpected file or directory"
            )
        if require_portable_candidate:
            if expected_id not in {root_digest, manifest_digest, config_digest}:
                raise VerificationError(
                    "tested candidate image ID is not cryptographically linked to "
                    "the saved root, runtime manifest, or config"
                )
            if expected_config_id is not None and expected_config_id != config_digest:
                raise VerificationError(
                    "portable candidate config image ID differs from its config "
                    "content digest"
                )
        elif expected_id not in {root_digest, config_digest}:
            raise VerificationError(
                "expected image ID is neither the saved OCI root nor config digest"
            )
        layout_name = "oci"
    else:
        if expected_attestation_id is not None:
            raise VerificationError(
                "a reviewed attestation cannot be required from a legacy archive"
            )
        legacy = LEGACY_CONFIG.fullmatch(config_path)
        if legacy is None:
            raise VerificationError(
                "Docker config path uses an unsupported archive layout"
            )
        config_raw = metadata.get(config_path)
        if config_raw is None or hashlib.sha256(config_raw).hexdigest() != legacy.group(
            1
        ):
            raise VerificationError(
                "legacy Docker config digest differs from its filename"
            )
        if expected_id != f"sha256:{legacy.group(1)}":
            raise VerificationError(
                "legacy Docker config digest differs from the expected image ID"
            )
        config_digest = f"sha256:{legacy.group(1)}"
        root_digest = config_digest
        manifest_digest = config_digest
        if expected_config_id is not None and expected_config_id != config_digest:
            raise VerificationError(
                "legacy Docker config digest differs from the expected config image ID"
            )
        if any(layer not in members for layer in layers):
            raise VerificationError("legacy Docker archive omits a declared layer")
        config_object = checked_json(config_raw, "legacy Docker image config")
        if not isinstance(config_object, dict):
            raise VerificationError("legacy Docker image config is malformed")
        layout_name = "legacy"

    if (
        config_object.get("architecture") != "amd64"
        or config_object.get("os") != "linux"
    ):
        raise VerificationError("Docker archive is not linux/amd64")
    supplied_candidate_values = (
        expected_context,
        expected_commit,
        expected_version,
        expected_build_variant,
    )
    if any(value is not None for value in supplied_candidate_values):
        if not all(
            isinstance(value, str) and value for value in supplied_candidate_values
        ):
            raise VerificationError(
                "candidate provenance and build-variant arguments must be supplied together"
            )
        assert (
            expected_context is not None
            and expected_commit is not None
            and expected_version is not None
            and expected_build_variant is not None
        )
        if re.fullmatch(r"[0-9a-f]{64}", expected_context) is None:
            raise VerificationError("expected source-context digest is invalid")
        if re.fullmatch(r"[0-9a-f]{40}", expected_commit) is None:
            raise VerificationError("expected source commit is invalid")
        if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", expected_build_variant) is None:
            raise VerificationError("expected build variant is invalid")
        if require_portable_candidate:
            expected_tag = (
                f"{expected_version}-{expected_commit[:12]}-"
                f"ctx{expected_context[:12]}-{expected_build_variant}-amd64"
            )
            if (
                ":" not in expected_ref
                or expected_ref.rsplit(":", 1)[1] != expected_tag
            ):
                raise VerificationError(
                    "portable candidate reference does not use its exact immutable "
                    f"{expected_build_variant} tag"
                )
        validate_candidate_runtime(
            config_object, expected_context, expected_commit, expected_version
        )
    return ArchiveIdentity(
        layout=layout_name,
        tested_image_id=expected_id,
        config_image_id=config_digest,
        root_image_id=root_digest,
        manifest_image_id=manifest_digest,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--expected-ref", required=True)
    parser.add_argument("--expected-id", required=True)
    parser.add_argument("--expected-config-id")
    parser.add_argument("--expected-source-context")
    parser.add_argument("--expected-source-commit")
    parser.add_argument("--expected-version")
    parser.add_argument("--expected-build-variant")
    parser.add_argument("--expected-attestation-id")
    parser.add_argument("--require-portable-candidate", action="store_true")
    parser.add_argument("--identity-output", type=Path)
    args = parser.parse_args()
    try:
        identity = verify_archive(
            args.archive,
            args.expected_ref,
            args.expected_id,
            args.expected_source_context,
            args.expected_source_commit,
            args.expected_version,
            args.require_portable_candidate,
            args.expected_config_id,
            args.expected_build_variant,
            args.expected_attestation_id,
        )
        if args.identity_output is not None:
            if args.identity_output.exists() or args.identity_output.is_symlink():
                raise VerificationError("identity output already exists")
            args.identity_output.write_text(
                "FORMAT_VERSION=1\n"
                f"TESTED_IMAGE_ID={identity.tested_image_id}\n"
                f"CONFIG_IMAGE_ID={identity.config_image_id}\n",
                encoding="utf-8",
                newline="\n",
            )
    except (OSError, VerificationError) as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(
        "Verified Docker save archive metadata, content addresses, and linked "
        f"identities ({identity.layout} layout)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
