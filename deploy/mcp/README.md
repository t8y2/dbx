# Authenticated DBX MCP on Linux

DBX's native `dbx-mcp` executable supports Streamable HTTP at `/mcp` and stdio.
The default transport remains stdio. HTTP always requires authentication.
This directory adds an OAuth resource-server deployment option for an existing
OAuth 2.1 identity provider. DBX does **not** implement an authorization server,
create users, issue access tokens, or collect identity-provider credentials.

## Package boundaries

The Linux **service bundle** contains `dbx` (CLI), `dbx-mcp`, deployment examples,
licenses, and build information. It is not a DBX Desktop GUI installer. The full
source archive/tag includes the combined fork changes: All database picker,
PostgreSQL Fault Lab, CLI/MCP connection CRUD and safe import, optional plaintext
credential export, and authenticated remote MCP. GUI-only features require a
Desktop build. The service build enables SQLite and DuckDB sidecar support; a
DuckDB sidecar or optional plugin/agent must be installed separately to use it.
MQ administration is not enabled in this service build.

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
   `nbf` is enforced. Opaque access tokens, HS256, and ID tokens are unsupported.
   Configure the API audience and scope only on access tokens, never ID tokens.
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
Removing a subject or rotating keys requires a restart and invalidates sessions.
Use short-lived access tokens; OAuth token revocation is not introspected by DBX.
The provider controls access/refresh token issuance and revocation.

## Run behind HTTPS

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

All MCP requests, including GET/SSE, POST, and DELETE, revalidate the bearer.
Sessions are bound to the authenticated subject, capped at 64, and expire after
15 minutes; clients must reinitialize after expiry/restart. Request bodies are
limited to 1 MiB and must finish within 5 seconds. There are at most 40 concurrent
body readers and 32 concurrent streams/operations, with eight reserved control
slots for cancellation notifications and DELETE. Bearer headers are removed
before SDK dispatch. Every operation and response stream ends by token expiry
or five minutes, whichever comes first. SDK idle cleanup and graceful
shutdown dispose connection/transaction state. These transport limits do not
replace database statement timeouts or proxy-level connection/rate limits.

## Existing static bearer and stdio modes

Existing `DBX_MCP_HTTP_TOKEN_FILE` or `DBX_MCP_HTTP_TOKEN` mode remains available
for trusted clients that already manage bearer secrets. Prefer a protected token
file. Do not configure either alongside OAuth. Static bearer mode is **not**
OAuth login and is not advertised as direct ChatGPT OAuth compatibility. Treat
all holders of a static bearer as the same profile owner. Token rotation
invalidates the old bearer and prevents it from reusing HTTP sessions.

The original stdio launchers and CLI behavior remain unchanged. Do not place
access tokens, database credentials, real exported bundles, or private key
material in a command line, test fixture, repository, release, or log.

## Verification/build

```sh
cargo test -p dbx-mcp --locked --no-default-features --features duckdb-sidecar,sqlite-bundled --lib
cargo test -p dbx-mcp --locked --no-default-features --features duckdb-sidecar,sqlite-bundled --test protocol --test connection_import --test connection_crud
cargo build -p dbx-cli -p dbx-mcp --locked --no-default-features --features dbx-cli/duckdb-sidecar,dbx-mcp/sqlite-bundled
```

Tests generate an ephemeral RSA signing key in memory and use loopback HTTP with
synthetic backends. They require no real identity provider, profile, database,
exported connection file, or credentials. Verify release checksums before use.
