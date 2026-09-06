# Deployment operations toolkit

This directory contains the reusable source for the hardened v7 maintenance
workflow developed for the Titra Docker Compose distribution.

- `build-v7-release.sh` renders a site-bound offline release from reviewed image
  archives and evidence.
- `build-v7-mongo-archive.sh` resolves the exact reviewed MongoDB 7.0.40
  Linux/amd64 dependency and emits its verified archive plus admission metadata.
- `verify-v7-release.sh` independently verifies the four-file release output.
- `remote-console-v7/` contains the attended root console template and tests.
- `remote-test-v7/` contains package templates, backup/deploy/rollback scripts,
  the isolated lab, static tests, and operator documentation.
- `remote-test-v7/manifest/release.env.in` is the only tracked release manifest;
  the builder renders `release.env` into its disposable staging tree.

The candidate image tag binds its version, source commit, source-context digest,
release profile, and architecture. The builder's generic profile is `hardened`;
use `--release-profile` to bind a different reviewed lower-case profile. The
selected profile is written to the release manifest and rechecked by the
independent verifier. `release-config.example` is illustrative only; copy it to
an ignored local name and keep site values out of source control.

## Pinned MongoDB dependency

Run `build-v7-mongo-archive.sh --help` on a controlled Linux or WSL release
workstation with Docker Buildx, a running Docker engine, and registry access.
The script verifies the public registry index, Linux/amd64 runtime child,
attestation relationship, pulled platform, local tag, and every saved archive
content address before atomically publishing a checksum and `mongo-image.env`.
Pass those two generated files to `build-v7-release.sh` with `--mongo-archive`
and `--mongo-metadata`.

The Mongo version and three public registry digests are intentionally pinned in
source. Updating them is a dependency review and code change, not an operator
argument. `--docker` and `--destination` remain configurable for workstation
portability. The default `dist-v7-mongo/` output and generated metadata are
ignored and must not be committed.

Generated releases and evidence are ignored. This branch intentionally has no
upload command and no knowledge of a particular production host.

Run the complete self-contained suite on Linux or WSL with:

```sh
deployment/test.sh
```

Set `NODE_BIN` when Node is not on `PATH`; a Windows `node.exe` visible through
WSL is supported. The suite uses synthetic Docker-save archives and never
connects to a registry, Docker daemon, production service, or remote host.
