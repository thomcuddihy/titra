# titra Open Source Security Policies and Procedures

This document outlines security procedures and general policies for the
titra Open Source project as found on https://github.com/kromitgmbh/titra.

  * [Reporting a Vulnerability](#reporting-a-vulnerability)
  * [Disclosure Policy](#disclosure-policy)

## Reporting a Vulnerability 

The titra OSS team and community take all security vulnerabilities
seriously. Thank you for improving the security of our open source 
software. We appreciate your efforts and responsible disclosure and will
make every effort to acknowledge your contributions.

Report security vulnerabilities by emailing the Atomist security team at:
    
    security@titra.io

The lead maintainer will acknowledge your email within 24 hours, and will
send a more detailed response within 48 hours indicating the next steps in 
handling your report. After the initial reply to your report, the security
team will endeavor to keep you informed of the progress towards a fix and
full announcement, and may ask for additional information or guidance.

Report security vulnerabilities in third-party modules to the person or 
team maintaining the module.

## Disclosure Policy

When the security team receives a security bug report, they will assign it
to a primary handler. This person will coordinate the fix and release
process, involving the following steps:

  * Confirm the problem and determine the affected versions.
  * Audit code to find any potential similar problems.
  * Prepare fixes for all releases still under maintenance. These fixes
    will be released as fast as possible to docker hub.

## Outbound integrations

Google, OpenID Connect, OpenAI, Zammad, GitLab, Siwapp, and Wekan credentials
are encrypted at rest with Meteor's AES-128-GCM OAuth encryption support. Set
one persistent `TITRA_OAUTH_SECRET_KEY` containing exactly 16 random bytes
encoded as canonical Base64 before saving credentials. On the first keyed
startup, legacy plaintext credential fields are converted with
compare-and-swap writes. Back up and preserve this key separately from
MongoDB: losing or changing it makes sealed credentials unreadable. Rolling
back to an application version without this support also requires restoring a
matching database backup.

A production process without this key may start only when no credential is
configured. Startup checks the existence of credential fields using ID-only
queries and aborts without reading or logging values if it finds one. New
secret writes also fail closed until the key is provisioned.

Zammad, GitLab, and Wekan task data and Siwapp invoice requests are fetched by
the server. Their tokens are write-only in the browser and are never included
in user or project publications. Outbound requests do not follow redirects and
use time, response-size, request-size where applicable, and result-count
limits. By default, endpoints must use HTTPS and resolve only to public IP
addresses. This protects the application host from server-side request
forgery.

Self-hosted installations that intentionally use private network addresses may
set `TITRA_PRIVATE_INTEGRATION_HOSTS` to a comma-separated list of exact
hostnames (for example, `gitlab.internal.example,wekan.internal.example`).
Wildcards and suffix matches are not supported. Only listed hostnames may
resolve to private addresses; plain HTTP remains blocked. Keep this list as
small as possible and only include hosts controlled by the operator. For local
development only, loopback HTTP can be enabled by setting
`NODE_ENV=development` and `TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS=true`.

Sandstorm Wekan URLs embed a capability in a URL fragment and previously
required connecting a browser directly to Wekan. That mode is intentionally
disabled because it cannot meet the server-only credential boundary. Use a
Wekan HTTPS API board export URL instead.

## Account bootstrap and registration

The first public registrant is not granted administrator rights by default.
For a brand-new, isolated installation only, an operator may set
`TITRA_ENABLE_FIRST_USER_ADMIN=true`, create exactly the intended first
account, then remove the setting and restart Titra before exposing it to
untrusted networks. Values other than the exact lowercase string `true` are
ignored.

If users already exist but there is no active administrator, the separate
`TITRA_ENABLE_ADMIN_RECOVERY=true` recovery window may be used to let one
signed-in user claim the role. Keep the service private during that window and
remove the setting immediately afterward.

Anonymous registration is enforced on the server and is closed unless the
`enableAnonymousLogins` database setting is the boolean value `true`. Ordinary
self-registration remains governed by `disableUserRegistration`.

## Security environment configuration

The supplied Compose recipe passes the security settings below from its local
`.env` file into Titra. Copy `.env.example` to `.env`, restrict that file to the
deployment account (for example, mode `0600` on Linux), and keep it out of
backups or support bundles that are shared without encryption. Boolean feature
flags require the exact lowercase value `true`; an empty value, `false`, or any
other spelling leaves the feature disabled.

| Variable | Default and intended use |
| --- | --- |
| `TITRA_OAUTH_SECRET_KEY` | Empty. Required before any integration credential can be stored. Use one persistent, canonical Base64 encoding of exactly 16 random bytes and back it up separately. |
| `TITRA_PRIVATE_INTEGRATION_HOSTS` | Empty. Optional comma-separated allowlist of exact private-network hostnames for trusted self-hosted integrations. HTTPS remains required. |
| `TITRA_ALLOW_LOOPBACK_HTTP_INTEGRATIONS` | Disabled. Development-only opt-in for loopback HTTP integration testing; it is ignored unless `NODE_ENV=development`. |
| `TITRA_OIDC_ALLOW_INSECURE_LOOPBACK` | Disabled. Allows loopback HTTP OIDC endpoints for local development. Never enable it on an exposed deployment. |
| `TITRA_OIDC_ALLOW_VERIFIED_EMAIL_LINKING` | Disabled. Allows an OIDC identity with an explicitly verified email claim to link to an existing local account. Enable only when the identity provider's email verification and account lifecycle are trusted. |
| `TITRA_ENABLE_UNSAFE_LEGACY_SCRIPTS` | Disabled. Restores execution of historical administrator-supplied JavaScript rules. This removes an important code-execution boundary and should be used only for a short, isolated migration window. Literal `return true` and `return false` rules work without it. |
| `TITRA_ENABLE_HSTS` | Disabled. Adds a one-year `Strict-Transport-Security` header. Enable only when the public site is permanently HTTPS, including every relevant subpath and proxy route. |
| `TITRA_OPENAI_MODEL` | Empty. Uses the application's reviewed default model. An override must contain only letters, digits, dots, underscores, or hyphens. |
| `TITRA_ENABLE_FIRST_USER_ADMIN` | Disabled. One-time bootstrap switch for a new, isolated database, as described above. Remove it immediately after creating the intended first account. |
| `TITRA_ENABLE_ADMIN_RECOVERY` | Disabled. Temporary, private maintenance switch for recovering an installation that has users but no active administrator. Remove it and restart immediately after recovery. |

Do not bake `.env` or the OAuth key into an image. Changing
`TITRA_OAUTH_SECRET_KEY` is not a normal key rotation: existing sealed
credentials must first be migrated or they become unreadable.
