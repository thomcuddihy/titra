#!/usr/bin/env python3
"""Static regression tests for the v7 CI and devcontainer trust boundaries."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLISH_WORKFLOW = ROOT / ".github" / "workflows" / "push.yml"
DOCS_WORKFLOW = ROOT / ".github" / "workflows" / "update-apidocs.yml"
DEVCONTAINER = ROOT / ".devcontainer" / "devcontainer.json"

REVIEWED_ACTIONS = {
    "actions/checkout": (
        "3d3c42e5aac5ba805825da76410c181273ba90b1",
        "v7.0.1",
    ),
    "actions/download-artifact": (
        "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        "v8.0.1",
    ),
    "actions/setup-node": (
        "820762786026740c76f36085b0efc47a31fe5020",
        "v7.0.0",
    ),
    "actions/upload-artifact": (
        "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        "v7.0.1",
    ),
    "docker/build-push-action": (
        "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
        "v7.3.0",
    ),
    "docker/login-action": (
        "dbcb813823bdd20940b903addbd779551569679f",
        "v4.6.0",
    ),
    "docker/setup-buildx-action": (
        "37fe631027851001ddb9b187196cc803df7f5f0e",
        "v4.3.0",
    ),
    "docker/setup-qemu-action": (
        "1f40c72289eff860ee54a304f1438e3cff362e0a",
        "v4.3.0",
    ),
    "softprops/action-gh-release": (
        "efb35369e0ad2afab669f228072c1b0d510eae64",
        "v3.0.3",
    ),
    "peaceiris/actions-gh-pages": (
        "84c30a85c19949d7eee79c4ff27748b70285e453",
        "v4.1.0",
    ),
}

USES_PATTERN = re.compile(
    r"^\s*uses:\s*([^@\s]+)@([0-9a-f]{40})\s+#\s+(v[0-9]+(?:\.[0-9]+){1,2})\s*$",
    re.MULTILINE,
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def job_block(workflow: str, name: str) -> str:
    match = re.search(
        rf"^  {re.escape(name)}:\s*$\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\Z)",
        workflow,
        flags=re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"workflow job is absent: {name}")
    return match.group("body")


class WorkflowHardeningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.publish = read(PUBLISH_WORKFLOW)
        cls.docs = read(DOCS_WORKFLOW)
        cls.workflows = {
            PUBLISH_WORKFLOW.name: cls.publish,
            DOCS_WORKFLOW.name: cls.docs,
        }

    def test_all_actions_use_reviewed_full_commit_and_tag_comment(self) -> None:
        seen: set[str] = set()
        for filename, workflow in self.workflows.items():
            uses_lines = [line for line in workflow.splitlines() if "uses:" in line]
            parsed = list(USES_PATTERN.finditer(workflow))
            self.assertEqual(
                len(parsed),
                len(uses_lines),
                f"{filename} contains an unpinned action or lacks a version comment",
            )
            for match in parsed:
                action, commit, version = match.groups()
                self.assertIn(action, REVIEWED_ACTIONS, f"unreviewed action: {action}")
                self.assertEqual((commit, version), REVIEWED_ACTIONS[action])
                seen.add(action)
        self.assertEqual(seen, set(REVIEWED_ACTIONS))

    def test_remote_shells_global_installs_and_mutable_runners_are_absent(self) -> None:
        combined = "\n".join(self.workflows.values())
        banned = {
            "curl piped to a shell": r"\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b",
            "wget piped to a shell": r"\bwget\b[^\n|]*\|\s*(?:ba)?sh\b",
            "global npm install": r"\bnpm\s+(?:i|install)\b[^\n]*\s(?:-g|--global)(?:\s|$)",
            "floating Ubuntu runner": r"\bubuntu-latest\b",
            "end-of-life Node 20": r"node-version:\s*['\"]?20(?:['\"]|\s|$)",
        }
        for description, pattern in banned.items():
            with self.subTest(description=description):
                self.assertIsNone(re.search(pattern, combined, flags=re.IGNORECASE))

    def test_node_24_and_locked_install_are_used_before_tests(self) -> None:
        publish_test = job_block(self.publish, "test")
        docs_build = job_block(self.docs, "build")
        for block in (publish_test, docs_build):
            self.assertRegex(block, r'node-version:\s*["\']24\.20\.0["\']')
            self.assertIn("npm ci --no-audit --no-fund", block)
            self.assertIn("run: npm test", block)
            self.assertLess(block.index("npm ci"), block.index("run: npm test"))

    def test_publish_job_cannot_start_before_tests(self) -> None:
        publish = job_block(self.publish, "publish")
        release = job_block(self.publish, "release")
        self.assertRegex(publish, r"(?m)^    needs: test$")
        self.assertIn("      - publish", release)
        self.assertIn("      - test", release)

    def test_image_is_built_once_then_promoted_by_digest(self) -> None:
        self.assertEqual(self.publish.count("docker/build-push-action@"), 1)
        self.assertEqual(self.publish.count("          push: true"), 1)
        self.assertIn("docker buildx imagetools create", self.publish)
        self.assertIn("--prefer-index=false", self.publish)
        self.assertIn('"kromit/titra@${IMAGE_DIGEST}"', self.publish)
        self.assertIn("Verify every published tag resolves", self.publish)
        self.assertIn("provenance: mode=max", self.publish)
        self.assertIn("sbom: true", self.publish)

    def test_credentials_are_not_available_to_test_job(self) -> None:
        test = job_block(self.publish, "test")
        self.assertNotIn("secrets.", test)
        self.assertIn("persist-credentials: false", test)

    def test_job_permissions_are_least_privilege(self) -> None:
        self.assertIn("\npermissions: {}\n", self.publish)
        self.assertIn("\npermissions: {}\n", self.docs)
        self.assertRegex(
            job_block(self.publish, "test"),
            r"(?m)^    permissions:\n      contents: read$",
        )
        self.assertRegex(
            job_block(self.publish, "publish"),
            r"(?m)^    permissions:\n      contents: read$",
        )
        self.assertRegex(
            job_block(self.publish, "release"),
            r"(?m)^    permissions:\n      contents: write$",
        )
        docs_deploy = job_block(self.docs, "deploy")
        self.assertRegex(
            docs_deploy,
            r"(?m)^    permissions:\n      contents: write$",
        )
        self.assertNotIn("id-token:", docs_deploy)
        self.assertNotIn("pages:", docs_deploy)

    def test_documentation_is_tested_and_uploaded_before_deployment(self) -> None:
        build = job_block(self.docs, "build")
        deploy = job_block(self.docs, "deploy")
        self.assertLess(build.index("run: npm test"), build.index("upload-artifact@"))
        self.assertRegex(deploy, r"(?m)^    needs: build$")
        self.assertIn("actions/download-artifact@", deploy)
        self.assertIn("peaceiris/actions-gh-pages@", deploy)
        self.assertIn("publish_branch: gh-pages", deploy)
        self.assertNotIn("run:", deploy)

    def test_apidoc_is_exact_and_integrity_checked(self) -> None:
        self.assertIn("APIDOC_SPEC: apidoc@1.2.0", self.docs)
        self.assertRegex(
            self.docs,
            r"(?m)^\s*APIDOC_INTEGRITY: sha512-[A-Za-z0-9+/]+=*$",
        )
        self.assertIn('npm pack "$APIDOC_SPEC"', self.docs)
        self.assertIn("createHash('sha512')", self.docs)
        self.assertIn('npm exec --yes --package="$apidoc_archive"', self.docs)
        self.assertIn('NPM_CONFIG_IGNORE_SCRIPTS: "true"', self.docs)


class DevcontainerHardeningTests(unittest.TestCase):
    def test_image_and_install_are_immutable(self) -> None:
        config = json.loads(read(DEVCONTAINER))
        image = config["image"]
        self.assertRegex(
            image,
            r"^geoffreybooth/meteor-base:3\.5\.1@sha256:[0-9a-f]{64}$",
        )
        expected_digest = (
            "1685815bf3d7be5f51052401119f9885ae2c8d6dcc2d1cf6b3235b1b764c9599"
        )
        self.assertEqual(
            image,
            f"geoffreybooth/meteor-base:3.5.1@sha256:{expected_digest}",
        )
        post_create = config["postCreateCommand"]
        self.assertEqual(post_create, "meteor npm ci --no-audit --no-fund")
        self.assertNotIn("npm install", post_create)


if __name__ == "__main__":
    unittest.main(verbosity=2)
