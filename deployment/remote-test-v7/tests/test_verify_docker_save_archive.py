#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from verify_docker_save_archive import (
    VerificationError,
    checked_json,
    main,
    scan_archive,
    verify_archive,
)

REFERENCE = "local/titra-test:portable"
VERSION = "1.0.12"
SOURCE_COMMIT = "a" * 40
SOURCE_CONTEXT = "b" * 64
BUILD_VARIANT = "hardened"
PORTABLE_REFERENCE = (
    f"local/titra-test:{VERSION}-{SOURCE_COMMIT[:12]}-"
    f"ctx{SOURCE_CONTEXT[:12]}-{BUILD_VARIANT}-amd64"
)


def encoded(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def descriptor(value: bytes, media_type: str, **extra: object) -> dict[str, object]:
    return {
        "mediaType": media_type,
        "digest": digest(value),
        "size": len(value),
        **extra,
    }


def add_file(archive: tarfile.TarFile, name: str, value: bytes) -> None:
    record = tarfile.TarInfo(name)
    record.size = len(value)
    record.mode = 0o600
    archive.addfile(record, io.BytesIO(value))


def build_oci_archive(
    path: Path,
    *,
    attestation: bool = False,
    outer_attestation: bool = False,
    corrupt_config: bool = False,
    reference: str = REFERENCE,
) -> tuple[str, str, str]:
    config = encoded(
        {
            "architecture": "amd64",
            "config": {
                "User": "node",
                "Entrypoint": ["/docker/entrypoint.sh"],
                "Cmd": ["node", "bundle/main.js"],
                "Healthcheck": {"Test": ["CMD", "true"]},
                "Labels": {
                    "org.opencontainers.image.title": "titra",
                    "org.opencontainers.image.source": "https://github.com/titraio/titra",
                    "org.opencontainers.image.licenses": "GPL-3.0-only",
                    "org.opencontainers.image.version": VERSION,
                    "org.opencontainers.image.revision": SOURCE_COMMIT,
                    "io.titra.source-context.sha256": SOURCE_CONTEXT,
                },
            },
            "os": "linux",
        }
    )
    config_descriptor = descriptor(config, "application/vnd.oci.image.config.v1+json")
    layer = b"synthetic compressed-layer bytes"
    layer_descriptor = descriptor(layer, "application/vnd.oci.image.layer.v1.tar+gzip")
    image_manifest = encoded(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": config_descriptor,
            "layers": [layer_descriptor],
        }
    )
    image_descriptor = descriptor(
        image_manifest,
        "application/vnd.oci.image.manifest.v1+json",
        platform={"architecture": "amd64", "os": "linux"},
    )
    root_descriptors = [image_descriptor]
    blobs = [config, layer, image_manifest]
    if attestation:
        attestation_manifest = encoded(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "subject": image_descriptor,
            }
        )
        root_descriptors.append(
            descriptor(
                attestation_manifest,
                "application/vnd.oci.image.manifest.v1+json",
                annotations={"vnd.docker.reference.type": "attestation-manifest"},
                platform={"architecture": "unknown", "os": "unknown"},
            )
        )
        blobs.append(attestation_manifest)
    root = encoded(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": root_descriptors,
        }
    )
    if outer_attestation:
        attestation_config = encoded({"architecture": "unknown", "os": "unknown"})
        statement = encoded({"_type": "https://in-toto.io/Statement/v0.1"})
        attestation_manifest = encoded(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": descriptor(
                    attestation_config, "application/vnd.oci.image.config.v1+json"
                ),
                "layers": [descriptor(statement, "application/vnd.in-toto+json")],
            }
        )
        blobs.extend([attestation_config, statement, attestation_manifest])
        outer_index_descriptors = [
            image_descriptor,
            descriptor(
                attestation_manifest,
                "application/vnd.oci.image.manifest.v1+json",
                annotations={"io.containerd.manifest.subject": digest(image_manifest)},
            ),
        ]
    else:
        blobs.append(root)
        outer_index_descriptors = [
            descriptor(root, "application/vnd.oci.image.index.v1+json")
        ]
    outer_index = encoded(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": outer_index_descriptors,
        }
    )
    docker_manifest = encoded(
        [
            {
                "Config": f"blobs/sha256/{digest(config).removeprefix('sha256:')}",
                "RepoTags": [reference],
                "Layers": [f"blobs/sha256/{digest(layer).removeprefix('sha256:')}"],
            }
        ]
    )
    with tarfile.open(path, "w:gz") as archive:
        for directory in ("blobs", "blobs/sha256"):
            record = tarfile.TarInfo(directory)
            record.type = tarfile.DIRTYPE
            record.mode = 0o700
            archive.addfile(record)
        for value in blobs:
            stored = b"corrupt" if corrupt_config and value == config else value
            add_file(
                archive,
                f"blobs/sha256/{digest(value).removeprefix('sha256:')}",
                stored,
            )
        add_file(archive, "index.json", outer_index)
        add_file(archive, "manifest.json", docker_manifest)
        add_file(archive, "oci-layout", encoded({"imageLayoutVersion": "1.0.0"}))
    return digest(root), digest(image_manifest), digest(config)


class DockerSaveArchiveTests(unittest.TestCase):
    def archive(
        self, **options: object
    ) -> tuple[Path, str, str, str, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        path = Path(temporary.name, "image.tar.gz")
        root_id, manifest_id, config_id = build_oci_archive(path, **options)
        return path, root_id, manifest_id, config_id, temporary

    def test_generic_wrapper_accepts_validated_root_index_identity(self) -> None:
        path, root_id, _, _, temporary = self.archive(attestation=True)
        with temporary:
            self.assertEqual(verify_archive(path, REFERENCE, root_id).layout, "oci")

    def test_portable_candidate_rejects_unlinked_tested_identity(self) -> None:
        path, _, _, config_id, temporary = self.archive()
        unlinked_id = f"sha256:{'f' * 64}"
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "not cryptographically linked"),
        ):
            verify_archive(
                path,
                REFERENCE,
                unlinked_id,
                require_portable_candidate=True,
                expected_config_id=config_id,
            )

    def test_portable_candidate_accepts_root_and_config_dual_identity(
        self,
    ) -> None:
        path, root_id, _, config_id, temporary = self.archive()
        with temporary:
            result = verify_archive(
                path,
                REFERENCE,
                root_id,
                require_portable_candidate=True,
                expected_config_id=config_id,
            )
            self.assertEqual(result.tested_image_id, root_id)
            self.assertEqual(result.config_image_id, config_id)

    def test_portable_candidate_accepts_manifest_and_config_dual_identity(
        self,
    ) -> None:
        path, _, manifest_id, config_id, temporary = self.archive()
        with temporary:
            result = verify_archive(
                path,
                REFERENCE,
                manifest_id,
                require_portable_candidate=True,
                expected_config_id=config_id,
            )
            self.assertEqual(result.manifest_image_id, manifest_id)
            self.assertEqual(result.config_image_id, config_id)

    def test_portable_candidate_rejects_wrong_config_identity(self) -> None:
        path, root_id, _, _, temporary = self.archive()
        wrong_config_id = f"sha256:{'e' * 64}"
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "config image ID differs"),
        ):
            verify_archive(
                path,
                REFERENCE,
                root_id,
                require_portable_candidate=True,
                expected_config_id=wrong_config_id,
            )

    def test_portable_candidate_requires_exact_variant_tag(self) -> None:
        path, _, _, config_id, temporary = self.archive()
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "immutable hardened tag"),
        ):
            verify_archive(
                path,
                REFERENCE,
                config_id,
                SOURCE_CONTEXT,
                SOURCE_COMMIT,
                VERSION,
                require_portable_candidate=True,
                expected_build_variant=BUILD_VARIANT,
            )

    def test_portable_candidate_accepts_exact_variant_tag(self) -> None:
        path, root_id, _, config_id, temporary = self.archive(
            reference=PORTABLE_REFERENCE
        )
        with temporary:
            result = verify_archive(
                path,
                PORTABLE_REFERENCE,
                root_id,
                SOURCE_CONTEXT,
                SOURCE_COMMIT,
                VERSION,
                require_portable_candidate=True,
                expected_config_id=config_id,
                expected_build_variant=BUILD_VARIANT,
            )
            self.assertEqual(result.layout, "oci")

    def test_candidate_provenance_requires_exact_build_variant(self) -> None:
        path, root_id, _, config_id, temporary = self.archive(
            reference=PORTABLE_REFERENCE
        )
        with (
            temporary,
            self.assertRaisesRegex(
                VerificationError, "provenance and build-variant arguments"
            ),
        ):
            verify_archive(
                path,
                PORTABLE_REFERENCE,
                root_id,
                SOURCE_CONTEXT,
                SOURCE_COMMIT,
                VERSION,
                require_portable_candidate=True,
                expected_config_id=config_id,
            )

    def test_portable_candidate_rejects_attestation_descriptor(self) -> None:
        path, _, _, config_id, temporary = self.archive(attestation=True)
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "attestation or additional"),
        ):
            verify_archive(path, REFERENCE, config_id, require_portable_candidate=True)

    def test_portable_third_party_archive_requires_exact_outer_attestation(
        self,
    ) -> None:
        path, _, manifest_id, config_id, temporary = self.archive(
            outer_attestation=True
        )
        with temporary:
            blobs, metadata, _ = scan_archive(path)
            index = checked_json(metadata["index.json"], "test index")
            self.assertIsInstance(index, dict)
            descriptors = index["manifests"]
            attestation_id = descriptors[1]["digest"]
            result = verify_archive(
                path,
                REFERENCE,
                manifest_id,
                require_portable_candidate=True,
                expected_config_id=config_id,
                expected_attestation_id=attestation_id,
            )
            self.assertEqual(result.manifest_image_id, manifest_id)
            self.assertIn(
                f"blobs/sha256/{attestation_id.removeprefix('sha256:')}", blobs
            )

    def test_portable_third_party_archive_rejects_unreviewed_outer_attestation(
        self,
    ) -> None:
        path, _, manifest_id, config_id, temporary = self.archive(
            outer_attestation=True
        )
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "reviewed OCI attestation"),
        ):
            verify_archive(
                path,
                REFERENCE,
                manifest_id,
                require_portable_candidate=True,
                expected_config_id=config_id,
                expected_attestation_id=f"sha256:{'f' * 64}",
            )

    def test_cli_writes_exact_dual_identity_record(self) -> None:
        path, root_id, _, config_id, temporary = self.archive()
        output = Path(temporary.name, "identity.env")
        arguments = [
            "verify_docker_save_archive.py",
            "--archive",
            str(path),
            "--expected-ref",
            REFERENCE,
            "--expected-id",
            root_id,
            "--require-portable-candidate",
            "--identity-output",
            str(output),
        ]
        with temporary, patch("sys.argv", arguments), io.StringIO() as stdout:
            with patch("sys.stdout", stdout):
                self.assertEqual(main(), 0)
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "FORMAT_VERSION=1\n"
                f"TESTED_IMAGE_ID={root_id}\n"
                f"CONFIG_IMAGE_ID={config_id}\n",
            )

    def test_content_address_mismatch_fails(self) -> None:
        path, _, _, config_id, temporary = self.archive(corrupt_config=True)
        with (
            temporary,
            self.assertRaisesRegex(VerificationError, "blob digest mismatch"),
        ):
            verify_archive(path, REFERENCE, config_id)


if __name__ == "__main__":
    unittest.main()
