#!/usr/bin/env python3

"""Create tiny deterministic Docker-save fixtures for the release-builder test."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1] / "remote-test-v7" / "tests"
sys.path.insert(0, str(TESTS))

from test_verify_docker_save_archive import (  # noqa: E402
    PORTABLE_REFERENCE,
    build_oci_archive,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=False)
    candidate = root / "candidate.tar.gz"
    predecessor = root / "predecessor.tar.gz"
    mongo = root / "mongo.tar.gz"
    candidate_id, _, candidate_config_id = build_oci_archive(
        candidate, reference=PORTABLE_REFERENCE
    )
    predecessor_ref = "local/titra-predecessor:test"
    predecessor_id, _, predecessor_config_id = build_oci_archive(
        predecessor, reference=predecessor_ref
    )
    mongo_ref = "mongo:test"
    mongo_id, _, mongo_config_id = build_oci_archive(mongo, reference=mongo_ref)

    evidence = root / "evidence"
    evidence.mkdir()
    names = (
        "admission.env",
        "build-context.manifest",
        "build-context.sha256",
        "image-history.txt",
        "image-inspect.json",
        "meteor-packages.txt",
        "runtime-node-packages.txt",
        "runtime-os-packages.txt",
    )
    for name in names:
        (evidence / name).write_text(f"fixture={name}\n", encoding="utf-8")
    checksums = "".join(f"{sha256(evidence / name)}  {name}\n" for name in names)
    (evidence / "SHA256SUMS").write_text(checksums, encoding="utf-8")

    source_digest = "d" * 64
    (root / "mongo-image.env").write_text(
        "format_version=1\n"
        f"source_ref=registry.example.invalid/mongo:test@sha256:{source_digest}\n"
        f"archive_ref={mongo_ref}\n"
        f"build_engine_image_id={mongo_id}\n"
        f"config_image_id={mongo_config_id}\n"
        f"archive_sha256={sha256(mongo)}\n"
        "created_at_utc=2026-01-01T00:00:00Z\n",
        encoding="utf-8",
    )
    (root / "fixture.env").write_text(
        f"CANDIDATE_REF={PORTABLE_REFERENCE}\n"
        f"CANDIDATE_ID={candidate_id}\n"
        f"CANDIDATE_CONFIG_ID={candidate_config_id}\n"
        f"PREDECESSOR_REF={predecessor_ref}\n"
        f"PREDECESSOR_ID={predecessor_id}\n"
        f"PREDECESSOR_CONFIG_ID={predecessor_config_id}\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
