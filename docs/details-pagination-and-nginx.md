# Details pagination and WebSocket repair

These are two independent issues. Correcting nginx's WebSocket forwarding does
not repair a JavaScript exception while building a Details query.

## Details `page` parameter

The router returns `undefined` when `page` is absent. The old table controllers
called `Number(undefined)`, producing `NaN`, which the hardened query validators
correctly rejected. All four Details views now normalize the route parameter
before building subscriptions, client selectors, or method calls.

- Missing, empty, malformed, negative, fractional, and over-limit values default
  to numeric page 1. Valid positive decimal page numbers retain their meaning.
- Server-side query validation and its resource ceilings are unchanged.
- Old result counts are cleared while the next query is loading, so a valid
  direct page link is not reset using a previous query's totals.
- Method-based views ignore responses from superseded page/filter requests,
  preventing late responses from restoring stale totals or rows.
- Pagination state follows removal of the URL parameter; handlers enforce
  boundaries independently of the controls' disabled CSS classes.
- The pagination component mounts even when the current page has no rows, so
  it can recover an out-of-range URL after the count arrives.

Regression tests execute the real controllers' creation autoruns and pagination
events, not just a stand-alone mock of numeric conversion.

Validation: all 777 Node tests passed, including 23 new pagination/controller
regressions, and the affected files pass the release lint configuration.

The final upstream-1.1.0-plus-pagination image was rebuilt and passed the
source-context, runtime-image and offline-archive admission checks. Its source
context is `7787daee75dff6b2b241fdcfff4515741f2a884063ca8bd0ad558bc68949f035`;
the archive SHA-256 is
`ebe077da620446e88b6b7798f114fa687d2b4d455c18086c2b54bbaecc574add`.
The local image tag ends in `ctx7787daee75df-upstream110-pagefix-amd64`.
Earlier review images are superseded by this one. These are pre-commit test
artifacts, not the operator release. On 2026-09-22 the operator approved
committing the fix and uploading a newly built, commit-bound release package;
its manifest and accompanying release instructions provide the final hashes.

This is a frontend code change and requires a newly built and deployed image.
Changing nginx alone will not put it into an already-running v7 image. Until
deployment, a valid `?page=1` (or `&page=1` when a query already exists) is a
temporary workaround for the missing-parameter exception.

## nginx WebSocket forwarding

The supplied site configuration comments out all three WebSocket proxy
directives. nginx does not automatically forward the hop-by-hop `Upgrade` and
`Connection` headers. See the official
[WebSocket proxy documentation](https://nginx.org/en/docs/http/websocket.html).

Inside the existing HTTPS server's `location /`, enable:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Also supply the original scheme and a longer idle timeout:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 300s;
```

Keep the existing upstream, Host/X-Forwarded-For headers, certificates, Certbot
includes, and HTTP redirect. The constant `Connection "upgrade"` is nginx's
documented simple pattern. A conditional map is an optional refinement, not
required for this repair. Do not change HTTP/2 or TLS configuration to fix this.

As root, first make a separate backup of the resolved site file (outside
`sites-enabled`, where backup files could be interpreted as active configs).
Then edit the site and validate before a graceful reload:

```sh
nginx -t && systemctl reload nginx
```

If validation fails, do not reload. Restore the saved file and repeat the test.
No Docker restart or database change is needed. After reloading nginx, reload
the browser and check that the SockJS WebSocket request receives HTTP 101 and
remains connected; merely advertising `websocket: true` in `/sockjs/info` does
not prove that the proxy upgrade succeeds.

The operator updated, validated and reloaded nginx on 2026-09-22. A subsequent
read-only live probe confirmed HTTP 200 on the site and a valid HTTP 101
WebSocket upgrade. The assistant did not modify the remote nginx configuration.
