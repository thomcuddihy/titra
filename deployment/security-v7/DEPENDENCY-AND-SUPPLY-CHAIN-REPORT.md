# Titra v7 dependency and supply-chain review

Review date: 2026-09-03

## Outcome

The v7 build uses Node.js 24.20.0 LTS and MongoDB 7.0.40, both pinned by immutable multi-platform image digest. MongoDB remains on the supported 7.0 release line to avoid an unrequested database-major migration. Meteor remains on the repository's tested 3.5.1 release.

Known vulnerable runtime versions found during the prior inventory were remediated as follows:

| Component | Prior runtime | v7 runtime | Method |
| --- | ---: | ---: | --- |
| `nodemailer` | 8.0.3 | 9.1.1 | Deterministic Meteor email dependency overlay |
| `openpgp` | 5.11.1 | 6.3.1 | Integrity-locked transitive override, with real PGP/MIME encrypt/decrypt compatibility test |
| `qs` | 6.13.x / 6.14.x / 6.15.x | 6.16.0 | Exact direct pin, override, and deterministic replacement of Meteor packages' embedded copies |
| `tar` | 6.2.1 | 7.5.22 | Node-gyp 13.0.2 server-runtime overlay |
| `tmp` | 0.2.3 | 0.2.7 | Exact direct pin and deterministic replacement of Meteor webapp's embedded copy |
| `underscore` | 1.13.7 | 1.13.8 | Exact server-runtime pin |
| `fast-uri` | 3.1.5 | 4.1.4 | Root transitive override |

`meteor-node-stubs` 1.2.29 is the latest published release but its tarball still embeds `qs` 6.15.2. npm cannot override bundled dependencies. The reviewed build therefore pins `qs` 6.16.0 at the application root and deletes only this browser-build copy before Meteor builds; normal module resolution uses the pinned root copy. Meteor's server bundle encodes package-local module paths, so its obsolete package-local `qs` and `tmp` copies are replaced in place with byte-identical copies of the locked root versions. The lockfile records the upstream tarball contents, while the built image contains only the reviewed implementations.

The Docker build no longer executes a mutable remote installer. The original Meteor npm installer tarball is verified before extraction; its dependencies are then installed from a reviewed lock that substitutes `tar` 7.5.22 and `tmp` 0.2.7 before the installer is run. The application, Meteor installer, server-runtime, and email-runtime locks are fixed and integrity checked. Runtime installation uses `npm ci`; lifecycle scripts are disabled for the email-only overlay. The final image runs as the unprivileged `node` user.

The release and API-documentation workflows pin third-party GitHub Actions by
full commit SHA, disable default token permissions, grant each job only its
required scope, avoid persisted checkout credentials, test before publishing,
and use the already admitted multi-platform manifest when copying between image
registries. The image build requests both maximal provenance and an SBOM.

## Verification

Run the offline policy check with:

```sh
npm run dependencies:check
```

The check reads only repository files. It enforces four reviewed locks, the reviewed version floors, SHA-512 integrity for npm registry artifacts, immutable Node/Mongo image references, and absence of `curl | sh` in the Dockerfile. It does not contact a vulnerability service or claim that no future advisory exists.

After building the final image, inventory it and confirm that:

- `/app/bundle/programs/server/npm/node_modules/meteor/email/node_modules/nodemailer/package.json` reports 9.1.1;
- the adjacent `openpgp` package reports 6.3.1;
- the server root reports `tar` 7.5.22 and `underscore` 1.13.8;
- no `tar` 6.x package exists and every runtime `qs`/`tmp` package reports the reviewed version.

The documented disposable SMTP integration test in `SMTP-INTEGRATION-TEST.md`
passed against the final admitted application image
`sha256:ff081f4398110f916546ab70105fa3f6ddc8a5cb259eae659d2265a67a6c4d87`.
It resolved the candidate immutably, used the exact reviewed Mongo 7.0.40 image
on an internal-only network, and confirmed that two concurrent Titra invitation
calls resulted in one captured message and one private daily-mail fence. It also
confirmed Nodemailer 9.1.1, complete labelled cleanup, no host-published ports,
no relay capability, synthetic-only data, and no production contact.

The same exact image passed `test_openpgp_runtime.cjs` with networking and
writes disabled. The test used its installed Nodemailer adapter and OpenPGP
6.3.1 runtime to generate an ephemeral ECC key, produce a PGP/MIME message,
decrypt it, and verify the original body.

## Residual and follow-up items

- A hosted advisory scan was deliberately not rerun because permission to transmit lockfile or dependency inventory metadata to such a service has not been granted. The offline denylist covers the findings already available, not unknown future vulnerabilities.
- The separately distributed, deliberately untracked Titra CLI 0.3.0 wheel was
  source-isolation tested and installed successfully with `pip check`. Its
  runtime and development requirements use bounded compatible ranges rather
  than a cross-platform hash-locked installation file. The reviewed WSL test
  environment resolved Click 8.5.0, HTTPX 0.28.1, Platformdirs 4.11.5, Rich
  15.0.0, Mypy 2.3.1, Pytest 9.1.1, pytest-cov 7.1.0, and Ruff 0.16.5. For
  unattended installation, generate and retain a platform-specific,
  hash-locked requirements set from an approved package mirror; do not mistake
  the wheel checksum alone for transitive-dependency provenance.
- The Meteor email overlay crosses a Nodemailer major version because no maintained fixed 8.x release is available. The disposable local test covers basic unauthenticated SMTP message creation and sending through Meteor's real notification path, but not provider DNS, credentials, TLS/STARTTLS, certificate validation, or delivery limits.
- `nodemailer-openpgp` 2.2.1 is still the latest published adapter, but it declares an obsolete exact OpenPGP 5.x dependency. The v7 overlay replaces that dependency with integrity-locked OpenPGP 6.3.1. A real, isolated Node 24.20.0 test generated an ephemeral ECC key, encrypted a Nodemailer PGP/MIME message through the adapter, and decrypted and verified its body successfully. The small adapter remains a maintenance residual because upstream has not published a release that declares OpenPGP 6.x itself; retain this functional test for every future mail-runtime change.
- Historical v5/v6 release evidence intentionally records the old images and must not be treated as the v7 runtime inventory.
- MongoDB 7.0 should receive future supported patch updates with backup/restore rehearsal; a move to MongoDB 8 requires a separately planned compatibility and rollback exercise.
- The local maintenance-r7 package is authenticated by independently retained
  SHA-256 values and an exhaustive internal checksum manifest, but it is not
  signed with a separate hardware- or identity-backed release key. Keep the
  console and bundle digests out of band; a future broadly distributed release
  should add signature verification and retain the generated SBOM/provenance
  beside the immutable image digest.

## Compose security options

`TITRA_PRIVATE_INTEGRATION_HOSTS` is passed through as an empty-by-default, comma-separated list of exact HTTPS hosts for deliberately approved self-hosted integrations. Do not set `TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS` in production; that switch is intended only for isolated local testing.

`TITRA_OAUTH_SECRET_KEY` is also passed through empty by default; no key is embedded in the image or compose file. Before storing any integration credential in production, generate one 16-byte Base64 key (for example, `openssl rand -base64 16`), store it in the root-only deployment environment, and keep that same key across every upgrade and rollback. A production process without a key aborts if it detects an existing credential; an empty installation may start keyless, but all credential writes fail closed. Losing or rotating the key without a separate credential migration makes existing sealed credentials unreadable.
