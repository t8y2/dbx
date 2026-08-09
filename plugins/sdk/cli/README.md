# dbx-plugin CLI

Creates and packages DBX plugins as frontend-only universal bundles or full-stack projects with Rust or Go sidecars.

For a complete Chinese walkthrough covering installation, templates, local DBX testing, signing, and publishing, see [`../../GETTING_STARTED.zh-CN.md`](../../GETTING_STARTED.zh-CN.md).

```bash
npm install --global @dbx-app/plugin-cli

dbx-plugin create
cd my-plugin
dbx-plugin package .
```

Or run the precompiled CLI without a global installation:

```bash
npx @dbx-app/plugin-cli create my-plugin
```

The npm launcher selects the matching macOS, Linux, or Windows binary and bundles the matching Rust and Go plugin SDK sources. Building the CLI from a DBX checkout is only necessary while developing the CLI itself.

## Project templates

`dbx-plugin create` offers three templates:

- `frontend` — sandboxed workbench UI with no native backend; produces one `universal` package.
- `rust` — sandboxed workbench UI plus a Rust sidecar; produces one package per native target.
- `go` — sandboxed workbench UI plus a Go sidecar; produces one package per native target.

Interactive terminals use a colored wizard, validate each answer, show a final summary, and ask before writing files. The default template is `frontend`.

For scripts and CI:

```bash
dbx-plugin create my-plugin \
  --template frontend \
  --id com.example.my-plugin \
  --name "My Plugin" \
  --publisher example \
  --description "My DBX plugin." \
  --version 0.1.0 \
  --yes
```

`--backend none|rust|go` is an alias for template selection. `--language rust|go` remains available as a compatibility alias for native projects.

Generated frontend-only projects contain:

```text
my-plugin/
├── dbx-plugin.toml
├── manifest.json
├── assets/plugin.svg
├── ui/index.html
└── .github/workflows/plugin-release.yml
```

Rust and Go templates add a `backend/` directory containing the native sidecar project.

## Packaging

`dbx-plugin package` reads `dbx-plugin.toml`, verifies that its optional backend matches `manifest.json`, stages only declared files, and reuses `dbx-plugin-packager` to generate:

- `<id>-<version>-<target>.dbxp`
- `<id>-<version>-<target>.artifact.json`

Frontend-only projects default to target `universal`. Native projects must be built on the matching target platform. Temporary stage and backend build directories are removed after both successful and failed package attempts.

Artifact metadata always includes target, URL, SHA-256, and size. The generated Release workflow publishes these files as unsigned review candidates. After approval, DBX Store signs official candidates and emits final metadata containing `signingKeyId`.

Use `--sdk-root /path/to/dbx` only with Rust or Go templates while developing unpublished SDK changes from a DBX checkout. Normal npm installations use the SDK sources bundled with `@dbx-app/plugin-cli`. Generated release workflows pin the precompiled CLI version so local and CI packaging use the same SDK contract.

## Signing

Official plugin authors do not create or manage signing keys. They publish unsigned candidates; DBX Store signs approved packages with the official repository key.

`keygen` is an advanced tool for private or custom repository operators. Packaging and signing are intentionally separate:

```bash
dbx-plugin keygen company-plugins.release
source .dbx-repository-signing-key.env
dbx-plugin package .
cargo run --release \
  --manifest-path /path/to/dbx/plugins/sdk/packager/Cargo.toml \
  -- sign dist/plugin.unsigned.dbxp dist/plugin.dbxp \
  --key-id "$DBX_PLUGIN_SIGNING_KEY_ID" \
  --artifact-metadata dist/plugin.artifact.json \
  --target universal
```

`keygen` writes `.dbx-repository-signing-key.env` with owner-only permissions on Unix and refuses to overwrite it unless `--force` is supplied. Generated plugin projects ignore this file by default.

The command prints the public key and key ID for configuring a custom repository trust root. The key ID is stable public metadata; the Ed25519 private seed in the generated file is secret and must stay in a password manager or protected repository-signing CI. `dbx-plugin create` and `dbx-plugin package` intentionally have no signing-key options.

## Terminal colors

Colors are enabled automatically for interactive terminals. Set `NO_COLOR=1` or `CLICOLOR=0` for plain text; set `CLICOLOR_FORCE=1` to preserve colors when piping output. `NO_COLOR` always takes precedence.

Run `dbx-plugin --help`, `dbx-plugin create --help`, or `dbx-plugin package --help` for the complete command reference.
