# DBX CLI

Command line interface for DBX database connections, schema inspection, safe queries, and prompt-ready schema context.

## Install

### npm

```bash
npm install -g @dbx-app/cli
```

### Homebrew

```bash
brew tap t8y2/dbx
brew install dbx-cli
```

The npm package installs the native CLI for the current platform automatically. Node.js 18.18.0 or newer is only needed for the npm launcher; direct native distributions do not require Node.js.

### Native downloads

The `packages-v*` GitHub Release also provides standalone native CLI archives:

| Platform | Archive |
| --- | --- |
| macOS Apple Silicon | `dbx-cli-darwin-arm64.tar.gz` |
| macOS Intel | `dbx-cli-darwin-x64.tar.gz` |
| Linux glibc ARM64 | `dbx-cli-linux-arm64-gnu.tar.gz` |
| Linux glibc x64 | `dbx-cli-linux-x64-gnu.tar.gz` |
| Windows ARM64 | `dbx-cli-win32-arm64.zip` |
| Windows x64 | `dbx-cli-win32-x64.zip` |

Verify the downloaded archive with `CLI-SHA256SUMS`, extract it, and run the native binary directly:

```bash
tar -xzf dbx-cli-linux-x64-gnu.tar.gz
chmod +x dbx
./dbx --version
./dbx connections list --json
```

Standalone binaries do not require Node.js. They read the same DBX connection storage as the desktop application; set `DBX_DATA_DIR` when using a custom or portable data directory.

## Usage

```bash
dbx doctor
dbx capabilities
dbx connections list --json
dbx connections list --format csv
dbx schema list local --json
dbx schema describe local users --json
dbx query local "select count(*) as total from users" --json
dbx query local "select id, name from users" --format csv
dbx query local "select * from users" --limit 50 --timeout 10s --json
dbx query local --file ./query.sql --json
dbx context local --tables users,orders
dbx open local users
```

## Commands

| Command                                     | Description                                           |
| ------------------------------------------- | ----------------------------------------------------- |
| `dbx doctor`                                | Show local DBX config and desktop bridge diagnostics  |
| `dbx capabilities`                          | Show direct-query and desktop-bridge database support |
| `dbx connections list`                      | List DBX connections without printing secrets         |
| `dbx schema list <connection>`              | List tables and views                                 |
| `dbx schema describe <connection> <table>`  | Show table columns                                    |
| `dbx query <connection> <sql>`              | Execute one SQL statement                             |
| `dbx query <connection> --file ./query.sql` | Execute SQL from a file                               |
| `dbx context <connection>`                  | Print compact schema context for prompts              |
| `dbx open <connection> <table>`             | Open a table in DBX Desktop                           |

## Output

Use `--json` or `--format json` for stable machine-readable output. Use `--format csv` for query, connection, and schema data that should be piped into other command line tools.

Errors are written to stderr and return a non-zero exit code.

## Query Controls

`dbx query` is read-only by default.

Use `--limit <n>` to control returned query rows and `--timeout <duration>` to control query timeout. Durations accept `ms`, `s`, or `m`, such as `500ms`, `10s`, or `1m`.

Use `--allow-writes` for non-dangerous write statements. Dangerous SQL such as `DROP`, `TRUNCATE`, and `ALTER` requires both `--allow-writes` and `--allow-dangerous-sql`.

For SQL that starts with a dash, pass `--` before the SQL:

```bash
dbx query local --json -- "-- comment
select 1"
```

## Default Connection

Set `DBX_CONNECTION` to omit the connection name for query and context commands:

```bash
DBX_CONNECTION=local dbx query "select 1" --json
DBX_CONNECTION=local dbx context --tables users,orders
```

## Desktop App Requirements

Some CLI commands can run without DBX Desktop:

- `connections list`
- `schema list`
- `schema describe`
- `query`
- `context`

Direct execution supports PostgreSQL/Redshift, MySQL-compatible databases (MySQL, Doris, StarRocks), and SQLite. Other database types use the DBX Desktop bridge or DBX Agent/JDBC infrastructure.

Use `dbx doctor` to check whether the DBX connection database, connection table, native SQLite loader, and desktop bridge are available. Use `dbx capabilities` to list direct-query and bridge-required database types.

If the optional platform package was not installed, reinstall without `--no-optional`:

```bash
npm uninstall -g @dbx-app/cli
npm install -g @dbx-app/cli
```

The native CLI does not require `better-sqlite3` and is not coupled to the Node.js ABI.

## Error Codes

CLI JSON errors use stable codes:

| Code                     | Meaning                                             |
| ------------------------ | --------------------------------------------------- |
| `UNKNOWN_OPTION`         | An unsupported flag was provided                    |
| `INVALID_OPTION`         | A flag is missing a value or has an invalid value   |
| `INVALID_ARGUMENT`       | Positional arguments are missing or conflicting     |
| `CONNECTION_STORE_ERROR` | DBX connection storage exists but could not be read |
| `CONNECTION_NOT_FOUND`   | No DBX connection matched the requested name        |
| `SQL_BLOCKED`            | SQL safety rules blocked execution                  |
| `DBX_NOT_RUNNING`        | DBX Desktop bridge is unavailable                   |
| `ERROR`                  | Unexpected runtime failure                          |

## Codex

Codex can call the CLI directly from shell tools:

```bash
dbx schema describe local users --json
dbx context local --tables users,orders | codex exec "Write a retention query"
```
