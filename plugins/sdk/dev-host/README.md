# Plugin development runtime

Generic browser development host for `dbx-plugin dev`. It loads declared workbenches and runs optional Rust/Go sidecars without starting the DBX desktop application.

```bash
dbx-plugin dev --path /path/to/plugin --port 5190
```

Requires Node.js 22+. Pure frontend projects do not need Rust or Go. Native projects need their own compiler and dependencies. The npm CLI bundles this runtime and a prebuilt UI; consumers do not install Vite, Vue, or build the development shell.

## Build from source

From the DBX repository:

```bash
npm ci --prefix plugins/sdk/dev-host
npm run build --prefix plugins/sdk/dev-host
cargo run --manifest-path plugins/sdk/cli/Cargo.toml -- dev --path /path/to/plugin
```

The Rust CLI locates `dist/runtime.mjs` relative to its source checkout. For a standalone native CLI, set `DBX_PLUGIN_DEV_RUNTIME` to the built entrypoint. `DBX_PLUGIN_NODE` selects Node. The npm launcher supplies both paths automatically.

## Project configuration

The CLI reads `manifest.json` and `dbx-plugin.toml`. Existing `[backend]` metadata selects Rust or Go and the executable name. Rust uses a cached debug target directory; Go uses a cached output directory. Explicit Git/path Rust SDK dependencies are not replaced by a crates.io patch.

Optional UI commands in `dbx-plugin.toml`:

```toml
[dev]
ui_build = ["npm", "run", "build"]
ui_watch = ["npm", "run", "build:watch"]
```

Commands are executable/argument arrays, run in the plugin directory without a shell. No framework detection or automatic dependency installation occurs. Without these options, existing UI assets are served and watched. Manifest or runtime changes require restarting `dev`.

When `ui_watch` is configured, its stdout must emit a standalone `DBX_UI_BUILD_SUCCESS` line after each successful, fully written build. Only this signal triggers automatic UI reload; partial output and failed builds do not. Add the signal to your build tool's successful completion hook (not an unconditional exit hook). Without `ui_watch`, static UI files retain debounced output watching. This protocol is independent of the frontend framework.

`--path` defaults to the current directory. `--port` defaults to 5190 and falls back to an available port if occupied; `0` explicitly requests an available port. `--data-dir` defaults to `<project>/.dbx-dev/`. Packaging rejects `.dbx-dev` inputs, including nested directories. Custom data directories must stay outside package include paths and the UI resource root, and be excluded from source control.

## Workbenches and connections

Workbench contributions can be opened without a connection, including frontend-only plugins. Connection providers generate forms from declared fields, defaults, options and bindings. Port zero remains valid at the framework layer; plugins validate their own connection semantics.

Connection testing, connecting and disconnecting use the standard lifecycle methods. Custom RPC methods and results are forwarded without interpreting their business meaning. Workbench tabs are keyed by contribution and optional connection ID, retain their iframe when switched, and reuse an existing tab when opened again. Closing the last tab for a connection disconnects it after confirmation.

Lifecycle replies with `success: false` are failures, matching the real host. Browser pages have independent workbench ownership. After a page's event stream disconnects, its frames remain for a 30-second reconnect grace period, then are removed; connections still used by another page remain open. Saved connection configuration is unaffected. Manifest localization is performed only by the shell; bootstrap returns one unmodified Manifest.

Import connection configurations using the UI's JSON file picker:

```json
{
  "connections": [
    {
      "providerId": "example.connection",
      "values": { "display_name": "Example", "host": "localhost", "port": 0 },
      "readOnly": false
    }
  ]
}
```

Field names come from the plugin manifest, not the runtime. Imported records get new IDs. There are no built-in protocol presets, filesystem RPCs or plugin-specific adapters.

## Supported boundary

- Host API 1.0 subset: `ready`, `context`, `locale`, `theme`, `request`, `invoke`, `notify`, `onInit`, `onContext`, `onEvent`, `onBinary`, `sendBinary`, resource reads and `openWorkbench`.
- Backend transports: default `stdio-jsonl` and explicit `stdio-framed`, protocol version 1. Initialization verifies plugin identity and version. Binary channels require framed transport.
- Permissions: event, binary and workbench navigation permissions are enforced. Unimplemented methods, such as `host.openFilesystem`, return errors. Native connection actions, query-result contributions and the DBX component kit are not emulated.
- JSON bridge parameters: 2 MiB. UI binary messages: 8 MiB. Sidecar JSON: 8 MiB. Sidecar binary: 64 MiB. Explicit bridge timeouts are clamped to 1–120000 ms, matching the host baseline.
- UI resources must be inline or loaded through `readAssetUrl`; relative module URLs are not a replacement for the declared asset bridge. The iframe uses `sandbox="allow-scripts"`, restrictive CSP and pure-data context snapshots. Direct networking is not enabled by the development runtime.

UI rebuilds are applied by explicit reload to preserve drafts. Backend rebuilds disconnect sessions; failure does not fall back to an old binary. A timeout does not mean a write was cancelled, and requests are never automatically replayed. Reconnect after restarting the backend; reload the plugin page when needed.

## Data and isolation

**自动重载** is off by default and applies to all browsers connected to this server. Enabling it confirms possible draft loss. Stable UI output changes reload all open plugin frames; compiled UIs still require `[dev].ui_watch`. Backend `.rs`/`.go` files and Cargo/Go module files within the configured backend directory trigger a debounced, serialized rebuild/restart. Generated `target`, `.dbx-dev`, `vendor` and `node_modules` directories are ignored. Saved connections persist, but reconnect after a backend restart. Build failure leaves the backend stopped; writes are never replayed. Turning the option off cancels pending work, not a build already started. Restarting the dev server resets the option to off. This is reload/restart, not state-preserving HMR.

The language button to the left of **调试** switches both the development shell and plugin locale between `zh-CN` and `en`. Shell controls, dialogs, diagnostic labels and manifest-localized contributions update together. Saved connection names and RPC data are not translated. With an active page, it confirms possible draft loss, then reloads that page automatically; cancellation leaves the language unchanged. Other open frames receive the standard `env` message. New pages use the selected locale. Plugin content must provide its own translations.

The **调试** button to the right of **重载页面** opens a bottom panel with the latest 500 entries, level filtering, local view clearing and automatic scrolling. Entries also print to the terminal with a `[dbx-dev]` prefix. Logs include the listening port, project/UI/backend paths, HTTP routes/statuses, RPC IDs/methods/durations, expandable JSON parameters/results, structured error data, events and session rejection reasons. Password/token/credential fields and manifest-declared secret fields are redacted recursively; binary/base64 content is omitted and large/deep values are truncated. Ordinary business values remain visible: use development data only. Raw backend error messages are excluded. History is memory-only and resets on restart.

The server listens only on `127.0.0.1`. Host, Origin, browser session, CSRF, resource traversal and symlink boundaries are checked. Frame source and generation are checked before routing messages, so responses from an old document cannot resolve new requests.

Development configurations, including credentials, are stored as plaintext in `.dbx-dev/connections.json`. Directory/file permissions are 0700/0600 where supported. Credentials are excluded from list summaries and iframe context; diagnostics redact recognized sensitive fields as described above. Explicit editing returns form values to the local development shell. Sidecar stderr is consumed without forwarding it to logs because arbitrary plugins may log credentials.

This is not an OS sandbox: sidecars run with the current user's privileges. It does not read the DBX profile or emulate Keychain, signing, installation, production lifecycle guarantees or desktop tab restoration. Validate those in the real host.

## Architecture and tests

### Agent diagnostics API

Local agents can read the same redacted in-memory diagnostics without browser cookies:

```bash
curl -sS \
  'http://127.0.0.1:5190/api/diagnostics?after=0&limit=100'
```

Only `GET` is supported. Use the actual port printed by `dev`. No custom header or browser session is required; the URL can be opened directly in a browser. Host/Origin checks remain enabled and no CORS access is granted.

Optional query parameters: `after` (exclusive numeric entry ID, default 0), `limit` (1–500, default 100), `level` (`debug`, `info`, `error`; exact match), and `instanceId` (from the previous response). The JSON response includes `entries`, `nextAfter`, `hasMore`, `instanceId`, `reset`, `truncated`, `oldestId`, `latestId`, `plugin`, `backendState`, and `port`.

Pass `nextAfter` and `instanceId` on the next poll, retaining the same filter. `hasMore` means fetch the next page immediately; otherwise poll at a modest interval, for example once per second. `reset` means the server instance changed or the cursor exceeds current history; the response already starts from available history. `truncated` means older entries were dropped from the 500-entry ring. Changing filters should start a fresh cursor. Polling does not create diagnostic entries. History is not persistent, and this endpoint cannot invoke plugin operations.

- `cli/src/dev.rs` (sibling crate): CLI arguments, configuration validation, build specifications and runtime location.
- `runtime.mjs`: build/watch processes, signal cleanup and runtime startup.
- `server.mjs`: HTTP/SSE sessions, declarative lifecycle and workbench routing.
- `sidecar.mjs`: JSONL/framed codecs, concurrent request correlation, events, timeouts and process cleanup.
- `connections.mjs`, `assets.mjs`: typed bindings, atomic configuration writes and confined resource access.
- `browser-bridge.mjs`, `ui/`: sandbox API, forms, tabs, themes and reload controls.

```bash
npm test --prefix plugins/sdk/dev-host
cargo test --locked --manifest-path plugins/sdk/cli/Cargo.toml
npm test --prefix packages/plugin-cli
DBX_PLUGIN_CLI_VERIFY_NATIVE=1 node scripts/verify-plugin-cli-package.mjs
```

The package verifier packs and installs the CLI into a temporary directory, exercises official frontend/Rust/Go templates, and starts their development runtimes without source-tree runtime dependencies. Runtime unit tests use an unrelated echo sidecar. Third-party plugins are external acceptance samples, not production runtime dependencies.
