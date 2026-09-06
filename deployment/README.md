# Deployment operations toolkit

This directory contains the reusable source for the hardened v7 maintenance
workflow developed for the Titra Docker Compose distribution.

- `build-v7-release.sh` renders a site-bound offline release from reviewed image
  archives and evidence.
- `verify-v7-release.sh` independently verifies the four-file release output.
- `remote-console-v7/` contains the attended root console template and tests.
- `remote-test-v7/` contains package templates, backup/deploy/rollback scripts,
  the isolated lab, static tests, and operator documentation.
- `remote-test-v7/manifest/release.env.in` is the only tracked release manifest;
  the builder renders `release.env` into its disposable staging tree.

Generated releases and evidence are ignored. This branch intentionally has no
upload command and no knowledge of a particular production host.

Run the complete self-contained suite on Linux or WSL with:

```sh
deployment/test.sh
```

Set `NODE_BIN` when Node is not on `PATH`; a Windows `node.exe` visible through
WSL is supported. The suite uses synthetic Docker-save archives and never
connects to a registry, Docker daemon, production service, or remote host.
