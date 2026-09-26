# DBX plugin platform

DBX plugins are optional, versioned `.dbxp` packages. They can add native backend behavior, sandboxed workbench UI, saved connection types, and filesystem providers without increasing the base DBX installation size. Declarative extension metadata consumed at build time lives here as well.

New plugin developers can read the official [Chinese documentation](https://dbxio.com/cn/docs/plugin-development) or [English documentation](https://dbxio.com/en/docs/plugin-development). The source files are also available as [Chinese MDX](../docs/content/docs/plugin-development.cn.mdx) and [English MDX](../docs/content/docs/plugin-development.mdx); the lower-level Chinese CLI walkthrough remains available in [`GETTING_STARTED.zh-CN.md`](./GETTING_STARTED.zh-CN.md).

Install the precompiled development CLI without cloning or compiling DBX:

```bash
npm install --global @dbx-app/plugin-cli
```

Marketplace listing pull requests go to `t8y2/dbx-store`. Plugin host, SDK, CLI, schema, documentation, and official-example changes go to `t8y2/dbx`. Ordinary plugin source stays in the plugin author's own repository.

The platform contract is manifest v1 + Host API 1.x + sidecar protocol v1. The source code for a plugin may live in this repository or in a separate repository; DBX installs only the built package.

## Repository layout

- `manifest.schema.json` — editor/CI schema for manifest v1.
- `marketplace.schema.json` — editor/CI schema for marketplace catalog v1.
- `sdk/rust/dbx-plugin-sdk` — Rust sidecar SDK.
- `sdk/go/dbx-plugin-sdk` — Go sidecar SDK.
- `sdk/cli` — Rust source for the `dbx-plugin create/package` CLI published as `@dbx-app/plugin-cli`.
- `sdk/packager` — deterministic `.dbxp` packager plus repository-side Ed25519 signing.
- `sdk/templates/github/plugin-release.yml` — caller template for multi-platform unsigned release candidates.
- `examples/hello-workbench` — complete connection provider + native sidecar + sandboxed workbench example.
- `RELEASING.md` — source ownership, release assets, official-store submission, and review workflow.
- `SIGNING.md` — repository-signing trust model, key rotation, and future author-attestation boundary.
- `connection-types/` — build-time registry for every DBX connection target, including databases, data services, message queues, and service registries.
- `dialects/` — SQL dialect descriptors, type catalogs, DDL templates, and metadata rules.
- `mappings/` — cross-dialect type mapping rules.
- `jdbc/` — legacy JDBC sidecar retained during migration to manifest v1; connects through vendor JDBC drivers and custom JDBC URLs.

Create a frontend-only universal plugin or a complete Rust/Go plugin project:

```bash
dbx-plugin create my-ui-plugin --template frontend
dbx-plugin create my-rust-plugin --template rust
dbx-plugin create my-go-plugin --template go
```

All generated projects include sandbox workbench UI, localized manifest metadata, `.dbxp` packaging configuration, and a GitHub Release workflow. Rust and Go templates additionally include a native sidecar and multi-platform build matrix; frontend-only projects publish one `universal` package.

## Source, package, and installation

These are separate artifacts:

1. **Source repository** — plugin authors build and test here or in another repository.
2. **`.dbxp` artifacts** — plugin CI publishes unsigned review candidates; the repository operator signs approved candidates and publishes the installable assets.
3. **Installed plugin** — DBX verifies and extracts the package under its plugin store.

Optional plugins are not bundled into the DBX base package. Installing SSH, SFTP, OpenDAL, or another future plugin increases only the local plugin store size.

## Marketplace and repository model

The Plugin Center separates three concerns:

- **Marketplace** aggregates enabled repositories, searches and filters catalog metadata, selects the current platform artifact, and installs or updates it.
- **Installed** manages the local plugin lifecycle and opens connection providers, workbenches, and filesystem providers.
- **Settings** manages local `.dbxp` installation, custom repositories, development-only unsigned packages, and advanced repository trust.

Repository configuration is persisted under the plugin store in `.repositories.json`. DBX always exposes one managed `dbx-official` repository backed by the official catalog:

```text
https://raw.githubusercontent.com/t8y2/dbx-store/main/catalog/index.json
```

The official URL is part of the DBX client contract and cannot be edited in Plugin Center settings. Official repository signing public keys are built into DBX; release builds may append rotation keys with `DBX_PLUGIN_MARKETPLACE_TRUSTED_KEYS_JSON`. Custom repositories use user-managed repository keys. The official repository accepts only DBX-managed keys, so adding a custom key cannot impersonate an official package.

Catalog v1 is defined by `marketplace.schema.json` and includes repository metadata, localized plugin metadata, searchable tags, permissions, versions, release notes, and target artifacts. Each artifact declares `signingKeyId`. DBX first selects the exact current target and then falls back to `universal`. Artifact URLs may be relative to the catalog URL. DBX enforces a 4 MiB catalog limit and a 512 MiB package limit, resolves only HTTP(S) URLs, limits redirects, isolates repository failures, verifies the catalog-declared size and SHA-256, then requires the package Manifest ID, version, publisher, permissions, and Ed25519 key ID to match the reviewed catalog before activation.

Run the live official-store smoke test with:

```bash
cargo run -p dbx-core --no-default-features --example plugin_marketplace_smoke
cargo run -p dbx-core --no-default-features --example plugin_marketplace_smoke -- <plugin-id> [version]
```

Without a plugin ID the smoke test verifies catalog availability and parsing. With a listed plugin ID it additionally downloads, verifies, installs, and reports the trusted signing key.

### Review and signatures have different jobs

- **Human review** decides whether a plugin is allowed into a curated catalog and whether `verified` may be shown.
- **Catalog SHA-256** proves that the downloaded release asset is the exact artifact selected by the reviewed catalog.
- **Ed25519 repository signing** proves that the installed package is exactly the artifact approved and published by that repository.
- **Runtime permissions and host boundaries** limit what the plugin UI can request after installation.

Review alone cannot protect an already approved download URL from later replacement. A signature alone does not mean the plugin is safe or reviewed; it only authenticates the signer and bytes.

### Recommended repository ownership

Keep the host, SDK, schemas, packager, and minimal examples in `t8y2/dbx`. The official catalog and review metadata live in the separate [`t8y2/dbx-store`](https://github.com/t8y2/dbx-store) repository:

```text
t8y2/dbx-store
├── plugins/              # reviewed metadata submissions
├── publishers/           # publisher identity and review records
├── revoked.json          # revoked versions or signing keys
├── catalog/index.json    # generated catalog v1
└── .github/workflows/    # schema, review, hash, and publish gates
```

Plugin source code may remain in independent author repositories. Author CI builds one unsigned `.dbxp` candidate per target and publishes it to GitHub Releases, a CDN, or object storage. The reusable release workflow emits `release-candidates.json` with Manifest identity plus verified candidate metadata. After review, the repository signing workflow signs the accepted bytes and publishes final artifacts and metadata; the catalog Git repository should not accumulate binary packages.

The same protocol supports future commercial deployment without changing package format: a public official repository, user-added third-party repositories, managed enterprise repositories with organization policy, and fully offline catalog/package mirrors. Credentials for private repositories must enter a secret-store-backed request layer rather than `.repositories.json`.

## Package layout

```text
example-1.0.0-darwin-arm64.dbxp
├── manifest.json
├── checksums.json
├── signature.json                 # required except explicit development installs
├── bin/
│   └── darwin-arm64/
│       └── example-plugin
├── assets/
│   ├── plugin.svg
│   └── connection.svg
└── ui/
    ├── index.html
    └── assets/...
```

`.dbxp` is a ZIP container with stricter rules:

- every file except `checksums.json` and `signature.json` must be covered exactly once by SHA-256 checksums;
- absolute paths, parent traversal, duplicate entries, symlinks, oversized entries, and decompression bombs are rejected;
- installed versions are immutable;
- activation records select the current version and support rollback;
- install, rollback, uninstall, and trust-store mutation share a filesystem lock;
- marketplace and normal local installs require a signature from a trusted Ed25519 repository key;
- unsigned packages require the explicit development-install toggle.

## Manifest v1

Add the schema to a manifest for editor validation:

```json
{
  "$schema": "../../manifest.schema.json",
  "manifest_version": 1,
  "id": "vendor.example",
  "name": "Example",
  "icon": "assets/plugin.svg",
  "version": "1.0.0",
  "source": "https://github.com/example/dbx-plugin",
  "homepage": "https://example.com/dbx-plugin",
  "engines": {
    "dbx": ">=0.5.68",
    "host_api": "^1.0"
  }
}
```

The runtime also validates semantic versions, engine ranges, IDs, contribution references, field types and bindings, entrypoint containment, current-platform binaries, and required backend/UI entrypoints. The JSON schema improves authoring but is not the security boundary.

### Entrypoints

```json
{
  "entrypoints": {
    "backend": {
      "executable": "bin/darwin-arm64/example"
    },
    "ui": {
      "root": "ui",
      "entry": "ui/index.html"
    }
  }
}
```

Use `stdio-jsonl` for ordinary request/event traffic. Use `stdio-framed` when PTY, SFTP, file transfer, or another feature needs binary channels. The workbench bridge transfers plugin-UI binary payloads as transferable `ArrayBuffer`s in both directions (8 MiB per message; chunk larger transfers), so UI-side binary traffic no longer pays a base64 round trip.

## Contributions

### `connection-provider`

A provider owns validation and connect/disconnect lifecycle for a saved non-SQL connection. DBX stores these as:

```text
ConnectionConfig
├── db_type: "plugin"
├── plugin_id
├── plugin_connection_provider
├── plugin_connection_type
├── common fields: name / host / port / username / password / database
├── external_config: provider-defined non-secret values
├── connection_secrets: provider-defined secrets
└── transport_layers: SSH jump / SOCKS / HTTP proxy
```

The provider-defined type, such as `ssh`, stays in `plugin_connection_type`; it does not extend DBX's exhaustive database enum.

Plugin authors may declare package-relative display metadata:

```json
{
  "name": "Example plugin",
  "icon": "assets/plugin.svg",
  "contributions": [
    {
      "type": "connection-provider",
      "id": "vendor.example.connection",
      "label": "Example connection",
      "icon": "assets/connection.svg"
    }
  ]
}
```

DBX resolves connection display metadata in this order: provider `label` / `icon`, plugin `name` / `icon`, then provider ID and the built-in generic plugin icon. Declared icon files must remain inside the plugin package and use SVG, PNG, JPEG, GIF, WebP, or ICO. SVG is rendered through an image URL rather than injected into the DBX document.

Field bindings:

| Binding                                                    | Storage                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `name`, `host`, `port`, `username`, `password`, `database` | matching common `ConnectionConfig` field                         |
| `config`                                                   | `external_config[field.key]`                                     |
| `secret`                                                   | `connection_secrets[field.key]`, persisted outside `config_json` |

Password fields default to `secret` when `binding` is omitted. DBX validates required values and value types before calling the plugin. The plugin receives the hydrated connection only in its backend lifecycle request; the workbench UI receives a connection ID and non-secret navigation context.

Absent optional fields stay absent: when DBX hands the manifest to its own UI it omits `description`, `placeholder`, `default`, and `binding` for fields that do not declare them, and `"default": null` means "no default" exactly like omitting the key. Treat a missing value as unset — never as an empty string, and never as the literal text `null`, which is not a storable plugin value.

Well-known field keys: a `config`-bound field keyed `connect_timeout_secs` declares the plugin's own connect/handshake timeout and is the single source of truth for it. On save, DBX mirrors its resolved value (the declared `default`, or the value a user entered in the connection form) into the typed `ConnectionConfig.connect_timeout_secs` — the dialog's generic global/per-connection timeout radios do not apply to providers declaring this field. The host's `connection/test` and `connection/connect` RPC deadline follows the same resolved value (stored `external_config` first, then the declared `default`), so the deadline never fires before the plugin's own timeout; providers that do not declare the field keep the generic typed-timeout behavior. Declare it when your transport needs more than the generic built-in 10s default (e.g. SSH handshakes on slow links).

#### Local file fields

A `text`, `password`, or `textarea` field may declare `picker` when the user should choose a local file (private keys, keystores, credential files):

```json
{
  "key": "private_key_path",
  "label": "Private key path",
  "type": "text",
  "binding": "config",
  "picker": { "kind": "file", "accept": [".pem", ".key", ".ppk"], "content_field": "private_key" }
}
```

- **Desktop hosts** open a native picker and store the chosen **absolute path** in the declaring field. The plugin backend runs on the same machine, so it can read the file itself.
- **Browser hosts** cannot resolve a path on the user's machine, so the same action becomes an **upload**: DBX reads the selected file and stores its **content** in `content_field` (which must be a declared `text` / `password` / `textarea` sibling), and clears the declaring field. A picker without `content_field` is therefore desktop-only and stays hidden in the browser.
- Switching source clears the other one: choosing a path removes the uploaded content and vice versa. This matters for fields that are alternatives — a plugin that prefers `private_key` content over `private_key_path` must not keep serving a stale upload after the user re-picked a path.
- `kind` is `file` (default use case) or `directory` (desktop-only: a browser cannot hand a folder to the plugin). `accept` lists up to 16 filters as extensions (`.pem`) or MIME types (`text/plain`) and is passed to the native dialog and the browser file input unchanged. Uploads are capped at 1 MiB.

`picker` is additive; hosts older than the release that ships it reject the manifest, so keep `engines.dbx` at or above that release when the form relies on it.

#### Conditional fields

A field may declare `visible_when` and `required_when`. A leaf clause matches when the referenced sibling field holds a non-empty value listed in `one_of`; listed values may be strings, numbers, or booleans and are compared by canonical string form, so `false` and `"false"` both match a boolean `false`. Clauses compose with `all_of`, `any_of`, and `not`:

```json
{
  "key": "sudo_command",
  "label": "Sudo command",
  "type": "text",
  "visible_when": {
    "all_of": [
      { "field": "sudo_source", "one_of": ["custom"] },
      { "field": "read_only", "one_of": [false] }
    ]
  },
  "required_when": {
    "all_of": [
      { "field": "sudo_source", "one_of": ["custom"] },
      { "not": { "field": "read_only", "one_of": [true] } }
    ]
  }
}
```

- `all_of` / `any_of` must contain at least one nested condition, nesting is limited to 8 levels and 64 nodes, and every referenced field must be a sibling declared by the same provider.
- Conditions cascade: while the field a clause reads is itself hidden, the clause does not count. A hidden container's stored default therefore cannot surface a grandchild field, and a hidden operand of `not` keeps the field dormant instead of lighting it up.
- DBX evaluates the same conditions for the dialog and for save/test/connect validation, so a manifest can never produce a form DBX itself rejects.
- Composite conditions were added after the single-clause contract; keep `engines.dbx` at or above the DBX release that ships them if the form relies on them.

Lifecycle methods receive:

```json
{
  "provider": { "id": "vendor.example.connection", "databaseType": "example" },
  "connection": { "id": "...", "db_type": "plugin", "...": "..." },
  "runtime": { "host": "127.0.0.1", "port": 49152 }
}
```

`runtime.host` and `runtime.port` are the final endpoint after DBX transport layers. A protocol plugin must connect to this endpoint instead of rebuilding DBX tunnels itself.

##### Transport proxy route for multi-endpoint targets

A static tunnel forwards exactly one remote endpoint. Protocols whose server advertises additional endpoints a client must dial (Kafka `advertised.listeners`, cluster discovery, etc.) cannot be served that way: the bootstrap endpoint connects, but every advertised broker is unreachable. Such providers declare `proxy_route` on the connection-provider contribution:

```json
{
  "type": "connection-provider",
  "id": "vendor.kafka.connection",
  "database_type": "kafka",
  "proxy_route": true
}
```

When transport layers are configured, DBX then delivers a SOCKS5 route instead of a static forward:

```json
{
  "provider": { "...": "..." },
  "connection": { "...": "..." },
  "runtime": {
    "host": "",
    "port": 0,
    "proxy": { "type": "socks5", "host": "127.0.0.1", "port": 49153, "username": "", "password": "" }
  }
}
```

- With SSH as the final transport layer the route is the hop's dynamic SOCKS5 endpoint (`ssh -D`); with a SOCKS5 proxy layer the route is that proxy, tunneled through any preceding layers. `username`/`password` are omitted when empty.
- `runtime.host`/`runtime.port` stay at the connection's logical endpoint, which the plugin should keep using as its seed/metadata source while dialing every endpoint through the SOCKS5 route. Credentials ride the same encrypted lifecycle channel as connection secrets and must never be logged by the plugin.
- Without the flag, transport layers keep the static-tunnel behavior, which requires the connection to resolve a single remote endpoint (providers should declare `host`/`port` bindings, as the SSH and LDAP plugins do); DBX rejects plugin connections that would tunnel to an empty endpoint instead of timing out silently.

#### Connection dialog actions

Connection providers may add ordered custom actions before DBX-owned lifecycle buttons:

```json
{
  "actions": [
    {
      "id": "discover",
      "label": "Discover endpoint",
      "variant": "outline",
      "requires_valid_form": false
    }
  ]
}
```

- `actions` declares only custom button metadata. DBX invokes `connection/action` with the action ID; plugins cannot choose arbitrary RPC method names.
- `test`, `save`, and `save-and-connect` are host-owned actions. DBX adds them from provider capabilities and dialog mode, validates the form, persists secrets through its secret store, and invokes the fixed lifecycle methods.
- A custom action may run with an incomplete form only when `requires_valid_form` is `false`; DBX still validates declared field types, secret keys, and transport configuration.
- `when` accepts `always`, `create`, or `edit`. `variant` accepts `default`, `outline`, `secondary`, `destructive`, or `ghost`. `timeout_ms` is limited to 1-120000 ms.
- `close_on_success` controls whether the connection dialog closes after a successful custom action.

`connection/action` receives the normal provider lifecycle payload plus `action: { id }`. It may return a message and updates for declared fields:

```json
{
  "success": true,
  "message": "Endpoint discovered",
  "fieldValues": {
    "host": "db.internal",
    "port": 5432
  }
}
```

`fieldValues` may contain only fields declared by that provider and must match their declared types. `null` clears a field. The plugin cannot write arbitrary `ConnectionConfig` keys or bypass DBX-owned save, secret persistence, transport, and connection lifecycle logic.

### `workbench`

A workbench opens in a normal persistent DBX tab. The iframe is loaded with `sandbox="allow-scripts"`, a restrictive CSP, no Tauri object, no parent DOM access, and no direct network access. The host injects `window.dbxPlugin`:

- `ready` / `context` / `locale` — `locale` is the current DBX locale such as `en` or `zh-CN`
- `theme` — `{ appearance: "light" | "dark", tokens }` with the resolved DBX design tokens; theme changes are pushed live through env updates, and the SDK applies them to the plugin document root
- `onContext(listener)` — context changes are pushed live; the iframe is not reloaded, so plugin UI state survives navigation
- `invoke(method, params, options)`
- `notify(method, params)`
- `sendBinary(channel, data)` — requires `host.binary`
- `readAsset(path)` / `readAssetUrl(path)`
- `openWorkbench(contributionId, context)` — requires `host.workbench`
- `openFilesystem(providerId, context)` — requires `host.filesystem`
- `getPlanCapabilities(connectionId)` / `explainPlan(request)` — reads an estimated execution plan for one connection; requires `host.plans:read`, see [Estimated execution plans](#estimated-execution-plans)
- `getTableMetadata({ connectionId, database?, schema?, table })` — reads narrow schema metadata for one table on an already-open connection; requires `host.schema:read`, see [Table Schema Metadata](#table-schema-metadata)
- `queryData({ connectionId, database?, schema?, sql, maxRows?, timeoutMs? })` — runs one read-only SQL statement on a connection the user granted to the plugin; requires `host.data:read`, see [Read-only data queries](#read-only-data-queries)
- `storage` — `storage.get(key)` / `storage.set(key, value)` / `storage.delete(key)` persist small JSON state per plugin in `plugin-data/<id>`; requires `host.storage`; values cap at 256 KiB and the whole store at 1 MiB, bulk data belongs in the sidecar's `DBX_PLUGIN_DATA_DIR`
- `ai.openConversation({ title, prompt, context, send? })` — opens a plugin conversation in the built-in DBX AI panel from a snapshot the plugin supplies; requires `host.ai`; `title` caps at 200 characters, `prompt` at 32000, and `context` at 2 MiB, and `send` defaults to `false` so pass `true` to start the analysis immediately. The host copies the snapshot into the conversation as history data and never hands model output or model configuration back to the plugin
- `capabilities` — `{ downloadFile, planApi, schemaMetadataApi, dataApi, storage, ai }` advertised in the init message; a missing or `false` entry means that Host API group is unavailable on this host, so gate the matching call on it instead of probing with a request
- `onEvent(listener)` — events are forwarded only with `host.events`
- `onBinary(listener)` — binary frames are forwarded only with `host.binary`; listeners receive `{ channel, data: Uint8Array }`

The sandbox default is no network access at all. A plugin may declare per-origin permissions such as `host.network:https://api.vendor.com` (https only, no path, at most 8 origins, duplicates rejected); declared origins — and only those — are added to the sandbox `connect-src`, so reviewers can see exactly which services the plugin UI may call.

All backend calls are rebound to the owning plugin ID by the host. A plugin UI cannot invoke another plugin.

### Official UI kit and theming

Every sandbox document ships with a small official component kit built on the DBX design tokens, so plugin UI follows light/dark mode and custom palettes automatically:

```html
<button class="dbx-btn dbx-btn--primary">Connect</button>
<input class="dbx-input" placeholder="Endpoint" />
<span class="dbx-badge">Ready</span>
```

Available classes: `dbx-card`, `dbx-section-title`, `dbx-btn` (`--primary` / `--danger` / `--ghost`), `dbx-label`, `dbx-input`, `dbx-select`, `dbx-textarea`, `dbx-hint`, `dbx-row` (label + field grid), `dbx-table`, `dbx-badge`, `dbx-link`. Custom plugin CSS can use the same `var(--color-*)` tokens; `document.documentElement.dataset.dbxTheme` reflects the current appearance.

Plugin-authored names, descriptions, contribution labels, form-field text, and select-option labels can be localized through `manifest.json > localizations`. DBX selects the exact current locale first, then its base language, and finally falls back to the manifest's default text:

```json
{
  "localizations": {
    "zh-CN": {
      "name": "示例插件",
      "contributions": {
        "vendor.example.connection": {
          "label": "示例连接",
          "fields": {
            "host": { "label": "主机", "placeholder": "请输入主机" },
            "mode": { "options": { "readonly": "只读" } }
          }
        }
      }
    }
  }
}
```

### `result-view`

A result view contributes a plugin-rendered visualization for query results. DBX shows one toolbar button per installed view next to the result grid; clicking it opens a plugin tab that renders the plugin's UI entrypoint with the current result as context:

```json
{
  "type": "result-view",
  "id": "vendor.example.graph",
  "label": "Graph"
}
```

A result view declares display metadata only: it carries no UI of its own and never names a workbench. The opened contribution id reaches the plugin UI in the init payload (`dbx-plugin-init` detail `contributionId`), so a plugin that declares several result views selects the matching one inside its single UI entrypoint.

The `context.result` snapshot is bounded — `{ columns, rows (<= 500), truncated }` plus `sql`, `connectionId`, and `database`. Plugins that need more rows can re-run a read-only statement with [`queryData`](#read-only-data-queries) (requires `host.data:read` and the user's consent for that connection). Requires a UI entrypoint.

### `context-menu`

A context-menu entry is rendered **natively** by DBX (no sandbox iframe, native theme and keyboard behavior) in the declared menu surface. v1 supports the saved-connection and table menus in the Sidebar Tree. Object Browser integration is not part of the first table contribution surface.

```json
{
  "type": "context-menu",
  "id": "vendor.example.inspect",
  "label": "Inspect endpoint",
  "menu": "connection"
}
```

For a table-scoped action, declare `menu: "table"`:

```json
{
  "type": "context-menu",
  "id": "example.inspect-table",
  "label": "Inspect table",
  "menu": "table"
}
```

A context-menu item can instead declare a host-handled Workbench action:

```json
{
  "type": "context-menu",
  "id": "vendor.example.generate",
  "label": "Generate test data",
  "menu": "table",
  "action": {
    "type": "open-workbench",
    "workbench": "vendor.example.main"
  }
}
```

The `workbench` reference must identify a `workbench` contribution in the same plugin manifest. This declarative action is resolved by the host and does not invoke the plugin backend.

For legacy entries without `action`, clicking a connection item dispatches `contextMenu/<id>` with the existing non-secret connection summary (`{ id, dbType, name, database }`) under `connection`. Clicking a table item uses the same backend method and dispatches:

```json
{
  "table": {
    "connectionId": "connection-id",
    "database": "example",
    "schema": "public",
    "table": "users"
  }
}
```

`database` and `schema` are optional and are omitted when the selected database does not expose those scopes. The table context contains object identity only; it never contains credentials, connection strings, or raw connection configuration.

For a declarative `open-workbench` action, DBX passes the current connection summary as Workbench context for `menu: "connection"`, and the stable `TableContext` object above directly as Workbench context for `menu: "table"` (without the backend `table` envelope). Connection context includes only `id`, `dbType`, `name`, and `database`; the host may also provide the standard `connectionId` for tab association. Neither path includes `host`, `port`, `username`, `password`, a connection string, or raw connection configuration. Reopening the same Workbench refreshes it with the latest invocation context.

A backend entrypoint is required only for legacy context-menu entries without a declarative action. Their `{ "message": "..." }` result continues to surface as a toast.

### `filesystem-provider`

A filesystem provider declares URI schemes, an optional icon, `root_uri`, and capabilities (`read`, `write`, `delete`, `rename`, `mkdir`). It is the reusable boundary for OpenDAL-like storage integrations: DBX owns the generic file-browser tab, while the plugin owns authentication, remote API calls, and provider-specific state. The provider icon is used for the saved connection in the sidebar and for its DBX tab; it falls back to the plugin-level icon when omitted.

A connection provider can set `filesystem_provider` instead of `workbench`. Opening that saved connection connects the plugin lifecycle and opens the DBX host file manager. A provider may declare both: DBX opens the custom workbench by default, and the sandboxed UI can call `openFilesystem(providerId, context)` with `host.filesystem` permission.

```json
{
  "type": "filesystem-provider",
  "id": "vendor.storage.files",
  "label": "Object storage",
  "icon": "assets/filesystem.svg",
  "schemes": ["s3"],
  "root_uri": "s3://bucket/",
  "capabilities": ["read"]
}
```

Host API 1.x defines these backend methods:

- `filesystem/list` receives `providerId`, optional `connectionId`, `uri`, optional pagination `cursor`, and a bounded `limit`. It returns `{ entries, nextCursor? }`.
- `filesystem/read` receives `providerId`, optional `connectionId`, `uri`, and bounded `maxBytes`. It returns `{ dataBase64, contentType?, truncated, etag? }` for preview-sized reads.
- `filesystem/write` receives `providerId`, optional `connectionId`, `uri`, `dataBase64`, `create`, `overwrite`, and optional optimistic-concurrency `etag`.
- `filesystem/createDirectory` receives `providerId`, optional `connectionId`, and `uri`.
- `filesystem/delete` receives `providerId`, optional `connectionId`, `uri`, and `recursive`.
- `filesystem/rename` receives `providerId`, optional `connectionId`, `sourceUri`, `targetUri`, and `overwrite`.

Every entry has `name`, canonical `uri`, `kind` (`file`, `directory`, `symlink`, or `other`), and optional `size`, `modifiedAt`, and `contentType`. DBX validates schemes, response sizes, base64, cursors, and entry metadata before the frontend sees a result.

Mutation methods return `{ success, message?, entry? }` and are rejected unless the provider declares the matching capability. Inline read/write payloads are capped at 4 MiB. The built-in file manager currently owns directory navigation, pagination, and bounded file preview. Large upload/download and PTY/SFTP streams use `stdio-framed` binary channels with plugin-defined transfer methods, chunk acknowledgements, cancellation, and progress events; they must not be encoded as one large JSON value.

### Table Schema Metadata

A plugin can read narrow, read-only schema metadata for one table without owning a driver, connection pool, credential, or SQL string. It reuses the canonical `PluginTableContext` identity used by table contributions:

```json
{
  "permissions": ["host.schema:read"]
}
```

```js
if (window.dbxPlugin.capabilities.schemaMetadataApi) {
  const metadata = await window.dbxPlugin.getTableMetadata({
    connectionId,
    database,
    schema,
    table: "users"
  });
  renderColumns(metadata.columns);
}
```

The result is deliberately narrower than DBX's internal `ColumnInfo`:

```json
{
  "columns": [
    {
      "name": "id",
      "dataType": "integer",
      "nullable": false,
      "precision": 32,
      "default": "nextval('users_id_seq'::regclass)"
    }
  ],
  "fieldCapabilities": {
    "length": "supported",
    "precision": "supported",
    "scale": "supported",
    "default": "supported"
  }
}
```

`columns` exposes only `name`, `dataType`, `nullable`, and optional `length`, `precision`, `scale`, and `default`. Comments, keys/indexes, credentials, connection strings, driver objects, and arbitrary SQL results never cross the boundary. Optional values remain omitted or `null`; the host never turns missing metadata into `0` or an empty string. `fieldCapabilities` reports `supported`, `unsupported`, or `unknown` for each structured optional field. `unknown` means DBX lacks reliable provider provenance and must not be treated as support.

`database` and `schema` are optional and omitted when unavailable. `connectionId` and `table` are non-empty, trimmed identity values capped at 256 characters. The host must already hold the matching connection/session: a saved-but-disconnected connection is rejected with `Connection is not open`, and a database without an open matching session is rejected instead of creating a pool or switching connections. The permission grants no arbitrary SQL and no write access.

This is Host API 1.3. A plugin that requires it declares:

```json
{
  "engines": { "host_api": "^1.3" }
}
```

The `schemaMetadataApi` capability is runtime detection for older hosts; a plugin should gate the call on it rather than probing the request. Without `host.schema:read`, the bridge rejects the call before the backend adapter runs.

### Read-only data queries

A plugin can run one read-only SQL statement on a DBX connection the user granted to it. It never receives a driver, pool, credential, or connection string:

```json
{
  "engines": { "host_api": "^1.4" },
  "permissions": ["host.data:read"]
}
```

```js
if (window.dbxPlugin.capabilities.dataApi) {
  const { columns, rows, truncated } = await window.dbxPlugin.queryData({
    connectionId,
    database,
    sql: "SELECT status, count(*) AS total FROM orders GROUP BY status",
    maxRows: 200
  });
}
```

The result is `{ dbType, columns: [{ name, dataType? }], rows, truncated, elapsedMs }`. The host owns every decision:

- **Consent per (plugin, connection).** The first query for a connection shows a host dialog naming both. An allow is persisted in `app_settings.plugin_data_grants` and listed under the plugin in Plugin Center → Installed, where it can be revoked; a denial is remembered for the workbench session. Uninstalling a plugin drops its grants. A revoked grant fails with `PLUGIN_DATA_ACCESS_NOT_GRANTED: …` and the next query asks again.
- **One read-only statement.** The statement must be the only one in the request and must be rated read-only by the shared SQL risk classifier used for MCP read-only access and the AI agent. Writes, DDL, locking reads, and session database switches (`USE …`) are rejected.
- **Open SQL connections only.** A saved-but-closed connection is rejected with `Connection is not open`; non-SQL connections are not served.
- **Bounds.** `maxRows` defaults to 500 (max 5000), serialized rows are capped at 8 MiB, and `timeoutMs` is clamped to the connection timeout and 60 s.

The backend re-checks the manifest permission and the grant on every call (`crates/dbx-core/src/query/plugin_data.rs`); the bridge only adds the consent prompt and a per-session cache. Hosts without a consent surface deny instead of granting.

### Estimated execution plans

A plugin can read the **estimated** execution plan of a query without touching a database driver, a credential, or a connection string. The host builds the `EXPLAIN` statement with its own `build_explain_sql`, applies the same read-only safety gate DBX uses for its own plan view, and executes it on the connection the plugin names. The plugin receives only the raw plan.

```json
{
  "permissions": ["host.plans:read"]
}
```

| Request | Purpose |
| --- | --- |
| `host.getPlanCapabilities({ connectionId })` | Reports what the host and this connection can plan. It only reads the stored connection config; it never connects or probes the server. The connection must already be open. |
| `host.explainPlan({ connectionId, database?, schema?, sql, mode, timeoutMs? })` | Returns the estimated plan for `sql`. The connection must already be open. |

`host.getPlanCapabilities` returns:

```json
{
  "dbType": "postgres",
  "dbVersion": "15.19",
  "supports": { "estimatedPlan": true },
  "limits": { "maxTimeoutMs": 60000, "maxPlanBytes": 4194304 }
}
```

- `supports.estimatedPlan` is `false` when this connection's dialect has no estimated plan path in DBX; disable the feature instead of calling `explainPlan`.
- `limits` are the host's ceilings. `maxTimeoutMs` already accounts for the connection's own query timeout, and a requested `timeoutMs` is clamped to it. A connection configured with no query timeout still gets the host ceiling.
- `dbVersion` is present only when DBX already learned the product version for this connection. The host never probes the server on the plugin's behalf.

`host.explainPlan` returns:

```json
{
  "dbType": "postgres",
  "dbVersion": "15.19",
  "format": "json",
  "rawPlan": [{ "Plan": { "Node Type": "Seq Scan" } }],
  "truncated": false,
  "warnings": []
}
```

- `format` is `json`, `xml` (SQL Server `ShowPlanXML`), or `text`. `rawPlan` is a parsed JSON document for `json` and the plan text otherwise, so the plugin can parse and normalize it itself.
- `warnings` carries `plan_not_json` when the server answered with something that is not JSON (the payload is then reported as `text` rather than pretending it is JSON), `plan_truncated` when the host cut the plan to respect `maxPlanBytes`, and `plan_rows_truncated` when the driver stopped collecting plan rows.
- `truncated` is `true` whenever the host cut the plan for either reason.

The sandboxed UI can call this through `window.dbxPlugin` directly:

```js
if (window.dbxPlugin.capabilities.planApi) {
  const capabilities = await window.dbxPlugin.getPlanCapabilities(connectionId);
  if (capabilities.supports.estimatedPlan) {
    const plan = await window.dbxPlugin.explainPlan({ connectionId, database, sql, mode: "estimated", timeoutMs: 15000 });
  }
}
```

Boundaries:

- **Estimated plans only.** `mode` must be `"estimated"`; any other value is rejected. Actual plans (`EXPLAIN ANALYZE`, `SET STATISTICS XML`) execute the statement and are not part of this API.
- **The plugin never supplies SQL to execute.** Only the source `sql` is accepted and the host builds the `EXPLAIN` statement itself, so a plugin cannot pass an `EXPLAIN` statement, a driver command, or an execution mode.
- **Read-only targets only.** The same gate DBX uses for its own plan view rejects multi-statement input, DDL, DML, and dangerous keywords. Oracle is the one dialect where DBX also plans DML, because `EXPLAIN PLAN FOR` does not execute it.
- **No credentials.** The response carries the plan and metadata only; a password, credential, connection string, or driver internals never cross this boundary, and the plan is not a user result set.
- **The connection must already be open.** DBX does not connect on a plugin's behalf. A saved connection that is currently disconnected is rejected by both `host.getPlanCapabilities` and `host.explainPlan` with `Connection is not open`; only a connection DBX already holds open can be planned.
- **`host.plans:read` is read-only.** It does not permit normal SQL execution, writes, DDL, or actual plans, and it is the only permission this API reads.
- **Bounded.** `limits.maxPlanBytes` caps the plan payload, `timeoutMs` is clamped by the host, and a plan that cannot be cut safely fails with an explicit error instead of returning a partial document.

Gate on capability rather than probing: read `window.dbxPlugin.capabilities.planApi` from the init message (an older host omits it), then confirm per-connection support with `host.getPlanCapabilities` before calling `host.explainPlan`.

The plan API is Host API 1.2, so a plugin that cannot work without it declares the floor in its manifest:

```json
{
  "engines": { "host_api": "^1.2" }
}
```

The manifest range is a compatibility floor and `capabilities.planApi` is the runtime check; keep both.

### Host API methods a plugin may call

Plugins normally answer requests, but Host API 1.1 adds one method a plugin backend may call back into DBX. Plugin-initiated requests use **string** ids (`"prompt-1"`), while DBX-owned requests and their responses keep numeric ids, so one stream carries both directions and older hosts that only understand numeric ids ignore the new frames instead of failing.

- `host/requestUserInput` asks the user a question through the DBX UI and returns the answer. It is the channel for anything the host cannot answer on the user's behalf: a bastion's keyboard-interactive MFA code, a one-time approval, a host-key confirmation, or a choice between accounts.

```json
{
  "jsonrpc": "2.0",
  "id": "prompt-1",
  "method": "host/requestUserInput",
  "params": {
    "prompt": "Verification code (6 digits)",
    "title": "JumpServer login",
    "echo": false,
    "default": "000000",
    "options": [{ "value": "jinpy", "label": "jinpy (admin)" }],
    "timeoutSecs": 300
  }
}
```

- `prompt` is required (≤2000 characters). `title` (≤200), `default` (≤1000), and `options` (≤8 entries, unique values, ≤200 characters each) are optional; `echo` defaults to `false`, so the dialog masks input unless the plugin says otherwise. `timeoutSecs` is clamped to 5-600 and defaults to 300.
- The result is `{ "action": "submit", "value": "123456" }`, `{ "action": "cancel" }`, or `{ "action": "timeout" }`. Only `submit` carries a value; treat `cancel` and `timeout` as "no answer" and fail closed — never fall back to a guess.
- The prompt is delivered through the same blocking dialog the host uses for its own host-key and keyboard-interactive prompts, so it also appears for `connection/test` and `connection/connect`. While a prompt is open DBX pauses the request deadline of the call that is waiting on it, so a user typing a code is never mistaken for a connect timeout.
- Errors come back as JSON-RPC errors: `-32001` means no user interface is attached (headless/MCP runs, or the desktop dialog is not mounted), `-32602` means the params are invalid, `-32601` means the host does not implement the method. A plugin must degrade gracefully on all three instead of blocking forever.
- DBX answers only with what the user typed. It never auto-fills, caches, or logs the value, and it allows at most four open prompts per plugin session.
- Capability gating: `plugin/initialize` advertises `host.hostApiVersion` (`1.1.0` or later) and `host.features` (containing `host.requestUserInput` when available). Only call the method when it is advertised; an older host reports `1.0.0` and drops the frame.
- The Rust SDK (`dbx-plugin-sdk`) wraps this: `dbx_plugin_sdk::host_client()`, `HostClient::supports("host/requestUserInput")`, and `HostClient::request_user_input(&UserInputPrompt::secret("Verification code"))`.

## Tools for the built-in AI assistant

A backend can expose tools to the built-in DBX AI agent through the MCP-shaped sidecar methods `mcp/tools` and `mcp/call` — the same methods DBX's MCP bridge uses:

```json
{"jsonrpc":"2.0","id":7,"method":"mcp/tools","params":{"connectionId":"<open connection id>"}}
{"jsonrpc":"2.0","id":8,"method":"mcp/call","params":{"tool":"orders_lag","arguments":{"group":"billing"},"lifecycle":{"provider":{},"connection":{},"runtime":{}}}}
```

`mcp/tools` returns `{ "tools": [{ "name", "description", "inputSchema", "annotations"? }] }`; `mcp/call` returns an MCP `CallToolResult` (`{ "content": [{ "type": "text", "text": "…" }], "isError": false }`). `lifecycle` is the open connection's `connection/connect` payload, with secrets resolved by the host and the runtime endpoint after transport layers.

Host rules (`crates/dbx-core/src/ai/plugin_tools.rs`):

- Tools are offered only for plugins the user enabled in Plugin Center → Installed → Built-in AI tools, only in Agent mode with API model providers, and only for plugin connections that are currently open.
- The host binds the connection: `connectionId` / `connectionName` are removed from the model-facing schema, and the bound `connectionId` is injected into the forwarded arguments when the plugin schema declares it. With several open connections the model chooses through an added `dbx_connection` argument.
- A tool runs without asking only when its entry sets `annotations.readOnlyHint: true`. Every other call pauses the run behind an inline approval that shows the exact forwarded arguments; unanswered approvals are denied after five minutes (`crates/dbx-core/src/ai/tool_approval.rs`). The hint is trusted because the plugin's native backend is already trusted code; the approval protects against model mistakes and prompt injection, not against a hostile plugin.
- Names are exposed as `<prefix>__<tool>` (`io.dbx.ssh` → `ssh__…`). Schemas are reduced to a provider-portable subset (`type`, `description`, `properties`, `required`, `items`, string `enum`, numeric/length/item bounds); argument names must match `[A-Za-z_][A-Za-z0-9_]{0,63}`.
- Discovery times out after 8 s per connection, calls after 120 s, and results are compacted before reaching the model.

## Backend protocol

The backend is a persistent child process with stdin/stdout reserved for the DBX protocol. Diagnostics must go to stderr.

### Initialization

DBX starts every sidecar with `plugin/initialize`:

```json
{
  "host": {
    "dbxVersion": "0.5.68",
    "hostApiVersion": "1.0.0",
    "protocolVersions": [1]
  },
  "plugin": {
    "id": "vendor.example",
    "version": "1.0.0"
  },
  "permissions": ["host.events"]
}
```

The plugin returns:

```json
{
  "protocolVersion": 1,
  "capabilities": ["connections", "events"],
  "plugin": {
    "id": "vendor.example",
    "version": "1.0.0"
  }
}
```

The host rejects a protocol or backend identity mismatch before exposing the session. This catches a package that points at the wrong executable even when the process otherwise speaks the protocol.

### JSON messages

Requests and responses follow JSON-RPC 2.0. Plugin events are JSON-RPC notifications emitted by the sidecar. The host supports concurrent in-flight requests, per-request timeouts, strict JSON-RPC validation for manifest v1, crash propagation, status reporting, bounded event buffers, and automatic child termination after handshake, protocol, or output failure. The Rust SDK dispatches work through a bounded configurable worker pool.

`stdio-jsonl` writes one JSON value per line. A single JSON message is limited to 8 MiB.

### Framed messages

`stdio-framed` uses a 5-byte header:

```text
kind: u8 | payload_length: u32 big-endian | payload
```

- kind `0`: UTF-8 JSON payload;
- kind `1`: `channel_length: u16 big-endian | channel UTF-8 | binary bytes`.

Binary payloads are limited to 64 MiB per frame. Channel names are validated. Use application-level chunking, offsets, acknowledgements, and cancellation for large transfers.

## Activation and process lifecycle

```mermaid
sequenceDiagram
  participant UI as DBX UI
  participant Host as PluginHost
  participant Sidecar as Plugin sidecar
  UI->>Host: invoke / test / connect / open workbench
  Host->>Host: resolve active compatible version
  Host->>Sidecar: spawn once on demand
  Host->>Sidecar: plugin/initialize
  Sidecar-->>Host: protocol + capabilities
  Host->>Sidecar: provider or workbench RPC request
  Sidecar-->>Host: result + events/binary frames
  Host-->>UI: typed result + plugin-scoped events
```

Sidecars are shared per plugin process, not spawned per tab. Plugins own their internal session registries. DBX tears down plugin-owned connection pools before replace, rollback, or uninstall. Uninstall is blocked while saved connections still reference the plugin.

## Security model

- **Package authenticity:** checksums + trusted Ed25519 repository keys.
- **UI isolation:** sandboxed iframe, restrictive CSP, bounded bridge payloads, safe asset paths, plugin identity binding.
- **Secret persistence:** plugin secrets are removed from connection JSON and stored through DBX's secret-store path. Ordinary cloud-sync snapshots always contain redacted placeholders. Secrets enter sync data only inside the encrypted payload when the user has configured a sync passphrase; without one, plugin secrets remain local and are not synchronized.
- **Native backend trust:** a native sidecar runs with the current OS user's privileges. A signature identifies the repository that approved and published the package; it is not an OS sandbox or proof that the author is harmless. Install only plugins whose backend code you trust.
- **Permission declarations:** privileged host bridge operations require declared permissions. Plugin UI network egress is fully blocked except for explicitly declared `host.network:` origins. Native process filesystem/network access cannot currently be completely mediated by DBX. `host.plans:read` grants reading host-generated estimated execution plans only; it never grants SQL execution, writes, DDL, or actual plans. `host.schema:read` grants only narrow metadata for a table on an already-open host connection; it never grants arbitrary SQL, writes, or reconnects. `host.storage` confines the workbench UI to a small JSON store inside its own `plugin-data/<id>` directory; it grants no other filesystem reach. `host.ai` lets a workbench open a built-in AI conversation seeded with a snapshot the plugin supplies; the plugin gets no model output, no model configuration, and no SQL execution out of it. `host.data:read` grants single read-only statements only on connections the user consented to, per plugin and connection, revocable in Plugin Center; it never grants writes, DDL, locking reads, database switches, or reconnects.
- **AI tool exposure:** plugin MCP tools reach the built-in AI agent only after the user enables the plugin for it, only on open connections, and — unless declared read-only — only after a per-call approval.

Custom repository public keys can be added or removed in Plugin Center. Obtain them through a channel independent from the downloaded package.

## Build and release

The complete author and official-store flow is documented in [`RELEASING.md`](RELEASING.md). Plugin authors keep source code in their own repository and publish unsigned candidates. DBX Store reviews and signs approved candidates, publishes installable artifacts, and records only catalog metadata in Git.

For a Rust backend:

```bash
cargo build --release --manifest-path path/to/backend/Cargo.toml
```

Stage `manifest.json`, declared assets, the current-target binary, and optional UI assets, then package:

```bash
cargo run --release \
  --manifest-path plugins/sdk/packager/Cargo.toml \
  -- path/to/stage path/to/vendor.example-1.0.0-darwin-arm64.dbxp \
  --artifact-metadata path/to/vendor.example-1.0.0-darwin-arm64.artifact.json \
  --target darwin-arm64
```

Repository operators sign an already-built candidate after review:

```bash
DBX_PLUGIN_SIGNING_KEY="..." \
cargo run --release \
  --manifest-path plugins/sdk/packager/Cargo.toml \
  -- sign path/to/vendor.example-1.0.0-darwin-arm64.unsigned.dbxp path/to/vendor.example-1.0.0-darwin-arm64.dbxp \
  --key-id vendor-release \
  --artifact-metadata path/to/vendor.example-1.0.0-darwin-arm64.artifact.json \
  --target darwin-arm64
```

Plugin authors do not receive the official repository private key. Never commit a repository signing seed. Publish the corresponding 32-byte public key separately and rotate it with a new `signingKeyId`.

For native plugins, copy `sdk/templates/github/plugin-release.yml` into the plugin repository and pin the reusable workflow to a released DBX plugin SDK tag or commit. Frontend-only plugins may replace the build matrix with one `universal` build.

## Compatibility policy

- Increment `manifest_version` only for manifest shape changes that an older DBX cannot interpret.
- Increment the sidecar protocol version only for wire-level incompatibilities.
- Use `engines.host_api` for host API compatibility and `engines.dbx` for product-version constraints.
- Additive contribution fields should remain optional within the same host API major version.
- Saved plugin connections must remain readable across plugin upgrades; migrate provider-owned `external_config` explicitly in the plugin backend when needed.

## Validation

Core checks:

```bash
cargo test -p dbx-core --no-default-features plugins::
cargo check -p dbx-web --no-default-features
```

SDK and example checks:

```bash
cargo test --manifest-path plugins/sdk/rust/dbx-plugin-sdk/Cargo.toml
cargo check --manifest-path plugins/sdk/packager/Cargo.toml
node plugins/examples/hello-workbench/package.mjs
node plugins/examples/hello-workbench/smoke.mjs
```
