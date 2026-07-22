# Contributing to DBX

Thanks for taking a look at DBX. Whether you fix a typo, improve docs, or tackle a database-specific bug, every PR helps.

## Where to Start

1. Browse [open issues](https://github.com/t8y2/dbx/issues) and choose one with no assignee or active contributor in its comments. Do not rely only on labels; read the full report, comments, and screenshots.
2. Comment on the issue you want to work on so others do not duplicate the effort. You can comment `/claim` to claim it.
3. Fork the repo, create a branch, and open a PR against `main`.

If you are not sure what to pick, choose an issue with clear reproduction steps, a small scope, or a database you can verify against a real instance. Follow the [complete website tutorial](https://dbxio.com/en/docs/contributing).

## Development Setup

### Prerequisites

- Node.js >= 22.13.0
- pnpm 10.27.0
- Rust >= 1.88
- Make

Linux desktop builds also need WebKit/GTK packages. See [README.md](README.md#getting-started) for the exact commands.

### Run Locally

```bash
git clone https://github.com/t8y2/dbx.git
cd dbx
make
```

`make` installs dependencies when needed and starts the Tauri desktop dev environment.

Useful shortcuts:

```bash
make dev-fast          # skip DuckDB during local dev
make dev-web           # frontend only
make dev-backend       # web backend only
make docs              # preview the documentation site
make cargo-check-fast  # fast Rust checks
```

### JDBC Agent Drivers

Agent driver projects live under `agents/`. Java/JDBC driver builds and tests require JDK 21; Gradle can auto-download the toolchain when available.

```bash
cd agents
./gradlew test
```

Do not manually edit `agents/versions.json` when changing an existing agent; the release workflow automatically bumps changed modules. Only new drivers add an initial version. New Java/JDBC drivers also update `agents/settings.gradle` and the supported-agent table; native drivers register their artifacts through the agent authoring/release checklist.

For a real local Java agent test, build the target `shadowJar`, back up and replace `~/.dbx/agents/drivers/<db_type>/agent.jar`, then restart DBX or reconnect the database. See the [complete website tutorial](https://dbxio.com/en/docs/contributing) for exact commands.

## Project Layout

| Path | Purpose |
| --- | --- |
| `apps/desktop/src/` | Vue frontend |
| `src-tauri/` | Tauri desktop shell and command layer |
| `crates/dbx-core/` | Shared Rust database logic |
| `crates/dbx-web/` | Docker / Web HTTP backend |
| `packages/cli/` | `@dbx-app/cli` |
| `packages/mcp-server/` | `@dbx-app/mcp-server` |
| `packages/mongo-shell/` | Private MongoDB editor parsing helpers |
| `docs/` | Official documentation site |
| `examples/` | Sample configs and automation scripts |
| `agents/` | JDBC agent driver projects |

## Making Changes

### Branch Naming

Use a short descriptive branch name, for example:

- `docs/web-api-reference`
- `fix/mysql-connection-timeout`
- `feat/redis-key-search`

### Scope

Keep PRs focused. A docs-only PR should not include unrelated code changes. A bug fix should not also refactor nearby modules unless that refactor is required for the fix.

### Commits

Write commit messages in plain language:

- `docs: add web API reference for Docker deployments`
- `fix(redis): handle empty scan cursor`
- `feat(schema): show catalog info for Doris`

### Tests

Run the checks that match your change:

```bash
make cargo-check-fast
make cargo-test-fast
pnpm test
```

For frontend or package changes, run the relevant package tests under `packages/` or `packages/app-tests/`.

### Documentation

User-facing docs live in two places:

- Repository docs: `README.md`, `CONTRIBUTING.md`, package READMEs, and `examples/`
- Website docs: `docs/content/docs/`

If you add a new docs page under `docs/content/docs/`, register it in:

- `docs/content/docs/meta.json`
- `docs/content/docs/meta.cn.json`

Preview locally with:

```bash
make docs
```

## Pull Requests

1. Push your branch to your fork.
2. Open a PR against `https://github.com/t8y2/dbx` `main`.
3. Link the related issue in the PR description.
4. Explain what changed, how you tested it, and any screenshots if the UI changed.

Small PRs are easier to review and merge.

## What We Are Looking For

- Documentation improvements and translations
- Reproducible bug fixes with clear before/after behavior
- Database-specific fixes where you can verify against a real instance
- Tests for non-trivial logic changes
- Examples that show CLI, MCP, Docker, or Web API usage

## Community

- [Discord](https://discord.gg/W7NyVDRt6a)
- [GitHub Issues](https://github.com/t8y2/dbx/issues)
- [Official docs](https://dbxio.com/en/docs/what-is-dbx)

Merged contributors appear on the [DBX contributors wall](https://dbxio.com/en/community).
