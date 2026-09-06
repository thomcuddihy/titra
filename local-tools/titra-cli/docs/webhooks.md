# Signed action-verification webhooks

Titra v6 has one endpoint that deliberately does **not** use the API token:
`POST /user/action-verification/webhook/:endpointId`. It authenticates the
exact request body with a separate 32-byte HMAC secret configured for that
endpoint. Never reuse a Titra API key as the webhook secret.

The CLI can validate a payload and preview the delivery without sending it:

```bash
export TITRA_ACTION_WEBHOOK_SECRET='the-43-character-base64url-secret'
titra --profile production webhook prepare \
  --endpoint-id 0123456789abcdef0123456789abcdef \
  --event-id provider-event-123 \
  --file ./event.json \
  --secret-env TITRA_ACTION_WEBHOOK_SECRET
```

`prepare` prints only the endpoint, event/request IDs, timestamp, body size and
SHA-256 digest. The HMAC signature is redacted and the JSON body is not echoed.
Receiver responses are read through a 64 KiB limit. Error bodies and messages
are never reflected; diagnostics retain only the HTTP status and a syntactically
safe request ID.
To deliver that event, use the same inputs and explicitly authorize the write:

```bash
titra --profile production webhook send \
  --endpoint-id 0123456789abcdef0123456789abcdef \
  --event-id provider-event-123 \
  --file ./event.json \
  --secret-env TITRA_ACTION_WEBHOOK_SECRET \
  --yes
```

## Durable delivery receipts and safe retry

`send` writes a private, fsynced delivery receipt **before** the HTTP POST. The receipt keeps the
exact body bytes as canonical base64, their SHA-256 digest, the stable event ID, and each request
ID/timestamp/status. It never stores the HMAC secret, signature, or API token. A payload or public
request identity containing either configured credential is rejected before anything is sent.

If delivery is interrupted or its outcome is unknown, the error includes the receipt ID. Inspect
only redacted metadata, then retry the journaled event rather than reconstructing it:

```bash
titra --profile production webhook list
titra --profile production webhook show RECEIPT_ID
titra --profile production webhook retry RECEIPT_ID \
  --secret-env TITRA_ACTION_WEBHOOK_SECRET \
  --yes
```

`show` and `list` expose only public IDs, endpoint, status/timestamps, body byte count and digest;
they never print the body/base64, signature, or secret. Retry preserves the original endpoint,
event ID, and exact body, but signs a fresh timestamp and new request ID. The exact redacted retry
is previewed before confirmation. Every attempt is journaled while an operation-scoped OS lock is
held through the network call, so concurrent retry processes fail closed.

Receipts are bound to the exact profile and normalized server. When the selected profile has an
API token, they are also bound to the immutable `/user/me` owner and cannot be listed, inspected,
or retried after token rotation to another user. A deliberately server-only invocation remains
server-only and does not perform bearer authentication. The server advertises a 604800-second
replay-retention guarantee. The CLI stops retries 600 seconds early—at age 604200 seconds—to
leave time for confirmation and transport before that guarantee ends; the expired receipt
remains available for investigation.

Instead of an environment variable, `--secret-file` accepts a regular,
non-symlink file. On POSIX it must have mode `0600` or stricter. If neither
source is supplied in a terminal, the secret is requested through a hidden
prompt. There is intentionally no `--secret` value option because command-line
arguments can be exposed by process listings and shell history.

The event ID is the provider's replay identity. Reusing it with different body
bytes is a conflict. The server accepts authentication timestamps only within
its advertised skew window (five minutes in the v6 contract), so normally omit
`--timestamp` and let the CLI use the current time. A receipt retry signs a fresh
authentication timestamp while the receiver retains the original event timestamp
for action ordering. An HTTP or connection failure with an
unknown outcome exits with code 6: inspect the durable local receipt and
provider/server receipt, then use `webhook retry RECEIPT_ID`. Replaying the same
event ID and identical body through that guarded command is the only safe retry
supported by the server contract.

Webhook delivery never attaches the user's Bearer API token. The normal Titra
profile is used only to select the server URL, TLS policy and timeout. Live
production verification skips this endpoint unless a separately configured
synthetic endpoint and secret are explicitly supplied; the ordinary API test
credential cannot test it.

An explicit `--credentials`/`--profile` selection determines the webhook
destination and is isolated from inherited `TITRA_SERVER`, `TITRA_URL`, and API
token variables. This prevents a shell environment from silently redirecting a
profile-selected delivery. Alternatively, `--server URL` (or `TITRA_SERVER`)
works without an API key because the HMAC is the receiver credential. Whenever
the selected connection source does contain an API token, the CLI compares it
locally with the HMAC secret and rejects accidental key reuse; the token is
never attached to the webhook request.

An explicit `--server URL` without an explicit `--api-key` is always HMAC-only. Any
ambient `TITRA_API_KEY` or `TITRA_API_TOKEN` is treated as sensitive but ignored for
authentication, so an operator-selected destination can never receive an inherited
Bearer credential.

## Exact destination validation

The destination must be an absolute `https://` Titra base URL. An HTTP URL is accepted only for
loopback testing, unless the operator explicitly supplies the global `--insecure` override.
Embedded usernames/passwords, query strings, and fragments are rejected. The CLI appends only
the fixed `/user/action-verification/webhook/` path and the validated 32-lowercase-hex endpoint
ID. TLS certificate verification is on by default.

When a credential file or profile is selected, `--server` and `--api-key` cannot be mixed into
that selection. Ambient Titra server/token variables are removed while the profile is resolved,
so its server and settings remain one atomic source. `prepare` shows the normalized server in the
redacted preview; verify it before approving `send`. Delivery disables HTTP redirects, so a 3xx
response cannot forward the signed body or signature to a new host.

## Exact accepted response

A send is reported as accepted only when all of these values match exactly:

- HTTP status is `202`;
- media type is `application/vnd.titra.v2+json`;
- response `X-Request-ID` equals the request ID that the CLI sent;
- the JSON object contains exactly `apiVersion` and `payload`, with `apiVersion: 2`; and
- `payload` contains exactly `accepted: true`.

An extra/missing field, wrong status or media type, mismatched request ID, malformed JSON, or any
other inconsistent 2xx response is treated as outcome unknown, not success. Connection failures,
5xx responses, and problem documents whose outcome is `unknown` are also outcome unknown. Keep
the original event ID, exact body bytes, request ID, and body digest for investigation; never
invent a new event ID merely because the response could not be verified. Authentication and
compare-and-swap/replay conflicts remain distinct failures and their sanitized problem details
never include the secret or signature.
