# DBX Hello Workbench plugin

This example exercises the complete manifest v1 path instead of mocking a contribution preview:

- native Rust sidecar built with `dbx-plugin-sdk`;
- protocol handshake and concurrent JSON-RPC requests;
- saved `connection-provider` with common/config/secret field bindings;
- test, connect, and disconnect lifecycle;
- per-connection backend registry;
- asynchronous connection/progress events;
- sandboxed workbench UI using `window.dbxPlugin`;
- workbench-to-sidecar RPC plus a read-only filesystem contribution rendered by DBX's host-owned file manager;
- unsigned `.dbxp` candidate packaging plus separate repository signing;
- automated install-to-uninstall smoke runner.

## Files

```text
hello-workbench/
├── manifest.json
├── assets/                # plugin and connection-provider icons
├── backend/               # native sidecar
├── ui/index.html          # sandboxed workbench
├── package.mjs            # current-platform unsigned candidate build
├── repository-sign.mjs    # custom repository signing example
├── repository-smoke.mjs   # candidate-to-signed-install end-to-end smoke
└── smoke.mjs              # package + lifecycle smoke test
```

The reusable smoke executable lives at `crates/dbx-core/examples/plugin_package_smoke.rs` so it shares DBX's workspace lockfile and dependency patches.

## Build an unsigned development package

From the DBX repository root:

```bash
node plugins/examples/hello-workbench/package.mjs
```

The package is written to:

```text
plugins/examples/hello-workbench/dist/
  dbx.example.hello-1.0.0-<target>.dbxp
  dbx.example.hello-1.0.0-<target>.artifact.json
```

The `.artifact.json` file contains the target, candidate URL, package SHA-256, and size used by review and multi-platform release aggregation. It intentionally contains no `signingKeyId`.

In DBX, open **Plugin Center**, enable **Allow unsigned development package**, and install the `.dbxp`.

## Use the example

1. Select **DBX Hello Workbench** in the plugin center.
2. Create a **Hello connection**.
3. Fill the host, port, greeting, and optional example token.
4. Click **Test**.
5. Click **Save & Open**.
6. Invoke the sidecar from the workbench.
7. Click **Open host files** to browse and preview the virtual `hello:/` filesystem without plugin-owned file-browser UI.

The example token is persisted through `connection_secrets`; the raw connection `config_json` contains only an empty placeholder. The iframe receives the saved connection ID, never the token.

## Run the real package smoke test

```bash
node plugins/examples/hello-workbench/smoke.mjs
```

The smoke runner performs:

```text
build package
→ install into a temporary plugin store
→ verify manifest compatibility
→ read plugin and connection-provider icon assets
→ start and initialize the native sidecar
→ test the provider connection
→ connect the saved plugin connection
→ invoke hello/greet
→ list and preview files through the typed filesystem host API
→ observe connection and progress events
→ disconnect
→ stop the sidecar
→ uninstall
```

To reuse an already-built package:

```bash
node plugins/examples/hello-workbench/smoke.mjs \
  plugins/examples/hello-workbench/dist/dbx.example.hello-1.0.0-darwin-arm64.dbxp
```

To verify a repository-signed package with marketplace policy, provide the trusted repository public keys:

```bash
DBX_PLUGIN_SMOKE_TRUSTED_KEYS_JSON='{"example-repository":"BASE64_32_BYTE_ED25519_PUBLIC_KEY"}' \
node plugins/examples/hello-workbench/smoke.mjs \
  plugins/examples/hello-workbench/dist/dbx.example.hello-1.0.0-darwin-arm64.signed.dbxp
```

## Sign as a custom repository operator

Official plugin authors skip this section because DBX Store signs approved candidates. To exercise the custom-repository flow, generate or load a repository key and sign the already-built candidate:

```bash
dbx-plugin keygen example-repository
source .dbx-repository-signing-key.env
node plugins/examples/hello-workbench/repository-sign.mjs
```

The script writes a `.signed.dbxp`, creates final artifact metadata containing `signingKeyId`, and refreshes the example catalog entry. Add the corresponding Base64 public key under **Plugin Center → Custom repository trust** before installing from that catalog.

Do not put the private seed in the repository or package. Distribute the repository public key through a channel independent from the `.dbxp` download.

Run the complete temporary-key flow without modifying the example catalog:

```bash
node plugins/examples/hello-workbench/repository-smoke.mjs
```

This builds an unsigned candidate, generates an ephemeral repository key outside the workspace, signs the reviewed candidate, installs it with strict signature policy, exercises assets/actions/connections/filesystem/events, uninstalls it, and removes temporary keys and Cargo targets.

Set `DBX_PLUGIN_OUTPUT_DIR` when automation should place candidate outputs outside the example `dist/` directory.

## Connection request shape

The backend lifecycle receives the hydrated connection and the final DBX transport endpoint:

```json
{
  "provider": {
    "id": "dbx.example.hello.connection",
    "databaseType": "hello"
  },
  "connection": {
    "id": "saved-connection-id",
    "db_type": "plugin",
    "plugin_id": "dbx.example.hello",
    "plugin_connection_provider": "dbx.example.hello.connection",
    "plugin_connection_type": "hello",
    "external_config": {
      "greeting": "Hello"
    },
    "connection_secrets": {
      "api_token": "hydrated only for the backend"
    }
  },
  "runtime": {
    "host": "localhost",
    "port": 22
  }
}
```

The workbench context is intentionally smaller:

```json
{
  "connectionId": "saved-connection-id",
  "providerId": "dbx.example.hello.connection",
  "connectionType": "hello"
}
```

## Adapt it for a real plugin

- SSH/SFTP: switch to `stdio-framed`, keep PTY/SFTP sessions in a backend registry, and use binary channels for terminal/transfer data.
- OpenDAL: keep credentials in the connection provider, implement filesystem methods in the backend, and let DBX own generic file-manager UI.
- Other tools: add contributions rather than adding a new DBX database enum variant or importing plugin Vue code into the main window.
