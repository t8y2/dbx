# Authenticated DBX MCP on Linux

DBX's native `dbx-mcp` executable supports Streamable HTTP at `/mcp` and stdio.
The default transport remains stdio. HTTP always requires authentication.
This directory adds an OAuth resource-server deployment option for an existing
OAuth 2.1 identity provider. DBX does **not** implement an authorization server,
create users, issue access tokens, or collect identity-provider credentials.

## Package boundaries

The examples target the native `dbx-mcp` service, not the DBX Desktop GUI.
OAuth changes only transport authentication and principal-owned request state;
it does not add connection CRUD/import tools, an export UI, or third-party
plugins. Build feature choices determine available database drivers and tools.
A DuckDB sidecar or optional plugin/agent must be installed separately when used.

## Owner-only deployment

Use a dedicated OS account and an owner-only data directory. Start with a fresh
profile and explicitly import only the database connections this service should
expose. Do not copy an entire personal home directory into a release or container.
DBX's existing connection/group/tool allowlists, global and per-connection
read-only settings, dangerous-SQL controls, and secret redaction remain enforced.
Enabling OAuth does not enable writes or bypass confirmation/import policies.

Every allowed OAuth subject shares the same configured DBX profile and its
permissions. This is an owner-controlled service, **not multi-tenant hosting**.
Use separate processes, data directories, OAuth audiences, and service accounts
for different owners. Require an explicit subject allowlist even if the issuer
is otherwise trusted. A valid token for another app, account, or scope is rejected.

## Configure your existing identity provider

1. Register the exact public MCP URL as the resource/audience, for example
   `https://dbx.example.com/mcp`. Configure an API permission such as `dbx:mcp`.
2. Configure an OAuth authorization-code flow with PKCE S256 and appropriate
   user consent. Publish authorization-server/OIDC discovery metadata over HTTPS.
   For ChatGPT, configure the supported client registration mechanism (CIMD,
   DCR, or a predefined client) and its exact redirect URI according to the
   current [OpenAI authentication guide](https://developers.openai.com/plugins/build/auth).
3. Configure **RS256 signed JWT access tokens** with `kid`, exact `iss`, resource
   `aud`, `exp`, stable `sub`, and a space-separated `scope` string. If present,
   `nbf` is enforced. Opaque access tokens and HS256 are rejected. This service
   requires access tokens; it does not separately enforce a JWT `typ` claim.
   Configure the API audience and scope only on access tokens, never ID tokens,
   so an ID token cannot satisfy the resource-server authorization checks.
4. Obtain the provider's **public** JWKS from its documented HTTPS endpoint.
   Place only the public RS256 verification keys in `/etc/dbx/public-jwks.json`.
   Each key must declare `kty: RSA`, `alg: RS256`, `use: sig`, and a unique `kid`.
   DBX rejects private or symmetric key material. Never put a client secret,
   private signing key, password, or bearer token in this file or in command args.
5. Copy `oauth.example.json` to `/etc/dbx/oauth.json`, fill the exact issuer,
   resource URL, public JWKS path, required scope, and your provider's stable
   subject ID. A relative JWKS path is resolved relative to the config file.
   Keep configuration writable only by the administrator.

Public keys are pinned and loaded once at startup; DBX makes no discovery/JWKS
network requests. For key rotation, atomically replace the public JWKS with the
provider's current trusted keys and restart. Remove compromised keys immediately.
Removing a subject or rotating keys requires a restart, which closes active
requests and discards the service's DBX session handles.
Use short-lived access tokens; OAuth token revocation is not introspected by DBX.
The provider controls access/refresh token issuance and revocation.

## Run behind HTTPS

Use the `Caddyfile.example` from this directory.

The example uses mutually exclusive [Caddy `handle` blocks](https://caddyserver.com/docs/caddyfile/directives/handle)
so `/mcp` and protected-resource discovery reach DBX while other paths, including
health/readiness probes, return 404 at the proxy. Its
[`enable_full_duplex` setting](https://caddyserver.com/docs/caddyfile/options#enable-full-duplex)
allows early HTTP/1 401/408/413 responses before an incomplete upload ends.
Header/body/idle timeouts bound slow readers without imposing a short response
write timeout on SSE. Merge these server options into an existing global block
if this proxy also serves other sites. The example was verified with Caddy 2.11.4.

The keyring-less Linux service also needs an explicitly configured profile key,
for example `DBX_SECRET_KEY_FILE` pointing to an owner-readable protected file.
Provision or migrate the dedicated profile using DBX's supported data-security
workflow first. Keep its existing key: generating a replacement key for an
existing profile can make saved secrets unreadable. Do not put key material in
command arguments, source, logs, or release assets.

Run locally first, using the supplied service example as a deployment template:

```sh
umask 077
export DBX_DATA_DIR=/var/lib/dbx
export DBX_MCP_OAUTH_CONFIG_FILE=/etc/dbx/oauth.json
export DBX_MCP_HTTP_ALLOWED_HOSTS=dbx.example.com
/opt/dbx/bin/dbx-mcp --http
```

The listener defaults to `127.0.0.1:5225`. Use `--http-port` to change the port.
The configured resource's path must match `DBX_MCP_HTTP_PATH` (default `/mcp`).
Place an HTTPS reverse proxy such as Caddy on the same host using
`Caddyfile.example`; valid DNS/TLS and provider setup are administrator tasks.
Preserve Host and Authorization, disable proxy buffering for SSE, and proxy the
protected-resource metadata path. Do not log authorization headers or bodies.
Do not expose the plaintext listener to the Internet. Only expose HTTPS on the
proxy; keep health/readiness probes private. The service does not trust forwarded
headers to change its authentication or public URLs.

Non-loopback binding additionally requires **both**
`DBX_MCP_HTTP_ALLOW_REMOTE=1` and `--http-allow-remote`, plus explicit host and
origin allowlists. This escape hatch is for a controlled reverse-proxy network;
it does not enable TLS. Loopback plus a local HTTPS proxy is recommended.

Browsers with an Origin header must match `DBX_MCP_HTTP_ALLOWED_ORIGINS` exactly.
Server-to-server requests with no Origin are permitted after authentication.
OAuth does not implicitly trust localhost browser origins. Configure only those
origins your chosen client actually requires.

## Connect an MCP client, ChatGPT, or dot

Use the public HTTPS `/mcp` URL with a Streamable HTTP client. On unauthenticated
requests DBX returns 401 and a `WWW-Authenticate` challenge pointing to
`/.well-known/oauth-protected-resource/mcp`. That public document identifies the
resource, required scope, and existing authorization server. No DBX profile,
connection details, keys, or allowed subjects are published.

For ChatGPT/dot, add the HTTPS MCP server through the product's supported custom
MCP/plugin connection flow and complete the provider's OAuth login and consent.
See [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Availability depends on the account/workspace and provider configuration. This
release verifies the resource-server side with synthetic tests, not a live
ChatGPT account or real provider. It does not install or connect itself to dot.

The HTTP transport is stateless for every supported protocol generation. Legacy
`2025-06-18` and `2025-11-25` clients use `initialize`; `2026-07-28` clients use
`server/discover` and send `MCP-Protocol-Version`, matching `Mcp-Method` (and
`Mcp-Name` for tool calls), plus `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` in each request's `params._meta`.
Neither lifecycle receives an
`Mcp-Session-Id`. Syntactically valid old transport IDs are ignored and stripped
before SDK dispatch; they grant no authority and do not select DBX state.

Every MCP request revalidates the bearer, owner allowlist, scope, Host and Origin.
After those checks, GET and DELETE return **405 with `Allow: POST`**. CORS
advertises only POST. POST responses may use SSE, but there is no standalone
GET/SSE channel, transport-session deletion, or completed-result replay/resumption.
Bearer headers are removed before SDK dispatch.

Explicit DBX handles, such as those returned by `dbx_open_session`, are separate
from transport sessions. They persist across requests within the authenticated
`(iss, sub)` principal; refreshing a JWT for that same principal does not discard
them. Another principal cannot use those handles, although all allowed subjects
still share the configured profile and its connection permissions. The service
caps principal state at 32 entries. Active request leases prevent idle eviction;
idle state is reaped and retiring state keeps its capacity slot until teardown
finishes. The principal idle timeout uses `DBX_SESSION_IDLE_TTL_SECS` (default
30 minutes), with a five-minute minimum for pending write confirmations. Explicit
DBX sessions retain their own idle timeout. Close handles explicitly when done.

Request bodies are limited to 1 MiB and must finish within 5 seconds. There are
at most 40 concurrent body readers and 32 POST operations, with each operation
slot held through its response lifetime. Eight separate slots admit
`notifications/cancelled`; their HTTP 202 means only that the notification was
accepted. The stateless SDK does **not** use a notification in one POST to cancel
another POST, even for the same principal. It cannot cancel another principal's
operation either. Clients cancel an in-flight operation by disconnecting that
request. JWT expiry, the five-minute request deadline, an authentication-policy
generation change, or service shutdown also terminate affected requests.

Idle cleanup and shutdown drain principal leases before disposing DBX state.
Normal open transactions are rolled back during cleanup. If cancellation occurs
while database work is in flight and its result is unknown, the transaction owner
discards that connection and prevents a later commit; it cannot promise an
explicit ROLLBACK on a connection whose state is unknown. These transport limits
do not replace database statement timeouts or proxy-level connection/rate limits.

## Existing static bearer and stdio modes

Existing `DBX_MCP_HTTP_TOKEN_FILE` or `DBX_MCP_HTTP_TOKEN` mode remains available
for trusted clients that already manage bearer secrets. Prefer a protected token
file. Do not configure either alongside OAuth. Static bearer mode is **not**
OAuth login and is not advertised as direct ChatGPT OAuth compatibility. Treat
all holders of a static bearer as the same profile owner. Token rotation
invalidates the old bearer and terminates requests tied to its old policy
generation. A replacement bearer has a different principal key and cannot
resume the old bearer's DBX handles. The old partition is retained until idle
cleanup or shutdown. Static bearer HTTP also uses the stateless transport.

The original stdio launchers and CLI behavior remain unchanged. Do not place
access tokens, database credentials, real exported bundles, or private key
material in a command line, test fixture, repository, release, or log.

## Verification/build

```sh
cargo test -p dbx-mcp --locked --no-default-features --features duckdb-sidecar,sqlite-bundled --lib
cargo test -p dbx-mcp --locked --no-default-features --features duckdb-sidecar,sqlite-bundled --test protocol
cargo build -p dbx-cli -p dbx-mcp --locked --no-default-features --features dbx-cli/duckdb-sidecar,dbx-mcp/sqlite-bundled
```

Rust tests generate an ephemeral RSA signing key in memory and use loopback HTTP with
synthetic backends. They require no real identity provider, profile, database,
exported connection file, or credentials. Verify release checksums before use.

### Released-binary HTTPS regression

This optional smoke test runs the actual `Caddyfile.example` and a supplied
`dbx-mcp` binary. It keeps the production route/timeout configuration and changes
only fixture host/ports, loopback binding, an ephemeral certificate, and private
Caddy settings (no admin API, public ACME, HTTP/3, or system trust installation).
The test CA is trusted only by the Python client. Profiles, signing keys and
certificates are generated at test time in an owner-only temporary directory and
removed when the test exits. No generated keys, profiles or reports belong in Git.

Use Python 3.10+ and an existing Caddy 2.11.4 installation from its official
release. Install the optional test dependencies in a virtual environment:

```sh
python3 -m venv /tmp/dbx-https-test
/tmp/dbx-https-test/bin/pip install 'aiohttp==3.13.5' 'cryptography==50.0.0'
/tmp/dbx-https-test/bin/python scripts/test-mcp-https.py /path/to/dbx-mcp \
  --caddy /path/to/caddy --protocol 2025-11-25 --report /tmp/dbx-https-2025-11-25.json
/tmp/dbx-https-test/bin/python scripts/test-mcp-https.py /path/to/dbx-mcp \
  --caddy /path/to/caddy --protocol 2025-06-18 --report /tmp/dbx-https-2025-06-18.json
/tmp/dbx-https-test/bin/python scripts/test-mcp-https.py /path/to/dbx-mcp \
  --caddy /path/to/caddy --protocol 2026-07-28 --report /tmp/dbx-https-2026-07-28.json
```

The report includes executable hashes and observable TLS 1.2/1.3, certificate
CA/hostname rejection, HTTPS metadata/audience/challenges, token rejections,
origin/host/body boundaries, incomplete uploads, initialize or discover/list/call,
absence of transport IDs, ignored old IDs across allowed subjects and refreshed
JWTs, POST-only CORS, authenticated GET/DELETE rejection, and notification ACKs.
Modern-protocol runs also reject missing request metadata and mismatched protocol
headers. Authentication is checked again on ordinary POSTs, not just discovery
or initialization. The proxy fallback is exercised
against `/`, `/healthz`, `/readyz`, and an unknown path. `--caddyfile` can select an
older or proposed deployment example to reproduce a configuration regression.
Only the example's supported directives are accepted; unexpected sites, imports,
listeners, or upstreams fail closed before Caddy starts.

The empty-profile smoke test cannot prove isolation of actual DBX handles,
in-flight cancellation, or principal cleanup. The report explicitly marks these
as untested. Synthetic Rust router tests exercise actual session handles across
legacy and modern clients, principal separation and JWT refresh, idle cleanup,
shutdown, request-disconnect/expiry handling, and notification ACKs that leave
other POSTs running. A successful notification response is never evidence that
an operation was cancelled.

When run successfully, these checks verify loopback HTTP and real encrypted
proxy-to-client traffic for the selected MCP protocol version. Run all three
commands to cover both protocol generations. They do not test public ingress,
DNS/ACME provisioning, a real identity provider, HTTP/2/3 client behavior, live
databases, or a ChatGPT/dot connection. Do not describe them as a public deployment
or end-to-end OAuth login test. DBX itself remains a plaintext loopback listener;
TLS terminates at the same-host proxy. No gRPC transport is added.
