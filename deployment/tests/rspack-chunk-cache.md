# Browser chunk-cache regression

Run the portable configuration tests with the normal Node test suite:

```sh
node --test rspack.config.test.mjs
```

Run the real bundler regression in the dependency-installed build environment
(WSL on Windows, because this workspace's native Rspack binding is Linux):

```sh
node deployment/tests/rspack-chunk-cache.mjs
```

The latter builds a tiny dynamic locale import four times in a temporary
directory. The source does not change; only module-ID assignment changes.
It demonstrates the old graph-hash URL collision and asserts that the actual
application configuration produces distinct final-content-hashed URLs without
changing the emitted module bodies. Its temporary build directory is removed
when the test exits. No application server, credentials or database is used.

## Observed failure and remedy

The previous v7 image and the initial 1.1.0 image both served
`build-chunks/8759.8c3e37daf6a1de75.js`, but with incompatible registration IDs:

| Release | Registered module | File SHA-256 |
| --- | --- | --- |
| Previous v7 | 2026 | `8dbca6a2b30cd815a394b84865b7c57ab0d6617a2eeffd4d1f83d6925c0aeec2` |
| Initial 1.1.0 | 9645 | `fd49a651540babe65316f82d6cab8a5d11080004e05239f195944bc1d7915ecf` |

The new main runtime requests module 9645. An existing browser cache can supply
the old response at that unchanged URL, which registers module 2026 instead.
The promise then fails inside Rspack's module loader with
`Cannot read properties of undefined (reading 'call')`.

This was reproduced with the exact deployed image against an empty synthetic
local fixture: current assets were clean; replaying the old locale response at
the colliding URL produced `MISSING MODULE 9645` on the sign-in page. All eight
inspected production startup chunks matched the packaged image, so this was
not an incomplete upload or a missing production file.

Production browser JavaScript chunks now use `[contenthash]` with
`optimization.realContentHash: true`. Rspack hashes final emitted bytes, so a
module-ID-only change also changes the URL. Existing cached graph-hash URLs
are no longer requested by the new runtime. Development and server output
naming remain controlled by Meteor; CSS already used content hashes.

References: [Rspack output.chunkFilename](https://v1.rspack.dev/config/output#outputchunkfilename)
and [optimization.realContentHash](https://v1.rspack.dev/config/optimization#optimizationrealcontenthash).

## Image acceptance

After a complete application build, check the generated runtime and locale
chunk URLs rather than only the source configuration. The new runtime must
not request the old colliding URL above. Test a fresh page load, sign-in and
authenticated Details against a disposable database; inspect the browser for
missing-module errors. Production records need not be changed.
