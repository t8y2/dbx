# Contributing to DBX

Thanks for helping improve DBX. This repository contains the desktop app, Rust backend, Docker service, documentation site, CLI, MCP server, and optional plugins.

## Project Layout

- `apps/desktop/` - Vue desktop frontend.
- `crates/dbx-core/` - shared Rust database core.
- `crates/dbx-web/` - Docker/web backend service.
- `src-tauri/` - Tauri desktop shell and native commands.
- `packages/` - Node packages, including CLI, MCP server, shared Node core, and app tests.
- `plugins/` - optional DBX plugins.
- `docs/` - documentation site and docs assets.
- `deploy/` - Docker and deployment assets.

## Development Setup

Required tools:

- Node.js `>=22.13.0`
- pnpm `10.27.0`
- Rust stable
- Java 17, when working on JDBC plugin packaging

Install dependencies:

```bash
pnpm install
```

Run the desktop app during development:

```bash
pnpm dev:tauri
```

Run the web backend:

```bash
pnpm dev:backend
```

## Checks

Before opening a pull request, run:

```bash
pnpm check
cargo fmt --check
cargo check --workspace --locked
```

> [!TIP]
> DuckDB compiles from source and takes a while. Skip it during routine
> development when you're not touching DuckDB features:
>
> ```bash
> cargo check --workspace --no-default-features
> cargo test  --workspace --no-default-features
> pnpm tauri dev -- --no-default-features
> ```
>
> Release builds and CI should always include DuckDB (omit the flag).

For package changes, also run:

```bash
pnpm test:packages
pnpm publish:dry-run
```

For Docker or deployment changes, run the relevant Docker Compose or Docker build checks from `deploy/`.

## Database Driver Metadata

When adding or changing a database type, update `crates/dbx-core/assets/database-drivers.manifest.json` first. The manifest is the shared source for driver mode, MCP/CLI routing, agent keys, support level, and top-level product capabilities.

Choose the support level conservatively:

- `connect` — connection and SQL/command execution only.
- `browse` — connection plus metadata browsing.
- `understand` — browsing plus higher-level understanding features such as search, object sources, or diagrams.
- `operate` — advanced operation surfaces such as table data editing, structure editing, import, transfer, database creation, explain plans, or user administration.

Set `capabilities` explicitly for the product surfaces DBX should expose. Keep detailed feature behavior in the owning feature module, such as table structure sub-capabilities or user administration dialects. Custom JDBC support should remain conservative unless dialect inference or a dedicated profile proves the advanced capability works.

Then run:

```bash
cargo test -p dbx-core --test database_capabilities
pnpm --filter @dbx-app/node-core exec tsx --test tests/driver-manifest.test.ts
pnpm --filter @dbx-app/mcp-server exec tsx --test tests/driver-manifest.test.ts
```

## Pull Requests

- Keep changes focused and reviewable.
- Include tests for behavior changes when practical.
- Update documentation when user-facing behavior changes.
- Use clear commit messages following Conventional Commits, such as `fix(app): clamp window size`.

## Reporting Issues

Use GitHub Issues for reproducible bugs, feature requests, database compatibility reports, and questions. Include the DBX version, operating system, database type, and relevant logs or screenshots when possible.
