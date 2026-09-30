# DBX CLI

Command line interface for DBX database connections, schema inspection, safe queries, and prompt-ready schema context.

## Install

### npm

```bash
npm install -g @dbx-app/cli
```

### Homebrew

```bash
brew tap t8y2/tap
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

## Official Agent Skill

The CLI binary includes the official DBX Skill for shell-capable AI agents. Enable it once after installing or upgrading the CLI:

```bash
dbx agent setup
dbx agent status
```

The default location is `~/.agents/skills/dbx`. `setup` runs entirely offline and can be repeated to install a newer bundled version. It refuses to overwrite an unmanaged or locally modified DBX Skill unless `--force` is supplied. Use `--skills-dir <path>` when the agent reads a different skills root.

## Usage

```bash
dbx doctor
dbx capabilities
dbx agent setup
dbx agent status --json
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
| `dbx agent setup`                           | Install or update the bundled official DBX Skill      |
| `dbx agent status`                          | Inspect the installed DBX Skill                       |
| `dbx connections list`                      | List DBX connections without printing secrets         |
| `dbx connections get <id-or-name>` | Inspect safe saved connection settings |
| `dbx connections add --file <path>` | Add a saved connection from protected JSON |
| `dbx connections update <id-or-name> --file <path>` | Partially update saved settings |
| `dbx connections import --file <path> [--yes]` | Preview or atomically import a local DBX bundle |
| `dbx connections remove <id-or-name> --yes` | Remove a saved connection and its credentials |
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
| `HOME_NOT_FOUND`         | The default user skills directory cannot be resolved |
| `SKILL_MODIFIED`         | An unmanaged or locally edited DBX Skill was found  |
| `SKILL_PATH_UNSAFE`      | A managed Skill path is a symbolic link             |
| `SKILL_READ_FAILED`      | An installed Skill file could not be read            |
| `SKILL_WRITE_FAILED`     | The bundled Skill could not be installed             |
| `ERROR`                  | Unexpected runtime failure                          |

## Codex

Codex can call the CLI directly from shell tools:

```bash
dbx schema describe local users --json
dbx context local --tables users,orders | codex exec "Write a retention query"
```

## Manage saved connections

These commands edit DBX connection configuration, without connecting to or modifying the database. Local mode requires an initialized DBX encrypted store and access to its existing key; these commands do not provision keys or bypass the data security upgrade. They share Desktop's encrypted storage and also work with `DBX_WEB_URL` when the Web server supports the update endpoint. All commands respect MCP connection/tool scope; mutations are blocked by global MCP read-only mode and scoped AI sessions. Configure access in **DBX Settings → MCP**. `--allow-writes` cannot override that policy for connection management.

```bash
dbx connections list --json
dbx connections get <id-or-name> --json
dbx connections add --file connection.json --json
dbx connections update <id-or-name> --file changes.json --json
dbx connections remove <id-or-name> --yes --json
```

Use a connection ID when names are ambiguous. `list` includes IDs and `read_only`; `get` returns supported settings without passwords, tokens, DSNs, URL parameters, scripts or tunnel/plugin secrets. Output is intentionally not a credential backup.

Create an owner-only JSON file (`chmod 600 connection.json` on Unix; restrict its ACL on Windows) using a secure editor, or pipe JSON from a credential manager with `--file -`. Terminal stdin is rejected to avoid echoing credentials. Do not place passwords in shell command arguments, history, inline JSON, or source-controlled files. The CLI has no password command-line flag. JSON input is limited to 1 MiB; errors never echo invalid input values.

Minimal `connection.json` without credentials:

```json
{"name":"scratch","db_type":"sqlite","host":"/absolute/path/scratch.db","port":0,"read_only":true}
```

Add accepts `name`, `db_type`, `host`, optional `port`, `username`, `password`, `database`, `ssl`, `driver_profile`, `read_only`, and `save_password`. Ports default to the database manifest when available; specify `0` for file databases.

Example `changes.json`:

```json
{"name":"scratch-renamed","read_only":false,"query_timeout_secs":60}
```

Update accepts `name`, `note`, `host`, `port`, `username`, `password`, `database`, `driver_profile`, `ssl`, `read_only`, `save_password`, `is_production`, `connect_timeout_secs`, `query_timeout_secs`, `idle_timeout_secs`, and `keepalive_interval_secs`. Omitted fields stay unchanged, including every saved credential and driver-specific setting. IDs and database types are immutable. Unsupported fields are rejected.

- `{"password":""}` explicitly clears the saved database password; omission preserves it
- `{"database":null}` or `{"driver_profile":null}` clears that optional setting; other fields do not accept null
- `{"save_password":false}` removes the saved database password; switching back to true does not recover it
- Changing connection settings invalidates cached connections and pinned transactions, so reconnect afterward
- Removal requires `--yes`, deletes the saved connection and its credentials, and cannot be undone by the CLI. Review the target first. Database files/data are untouched. Keep an authorized DBX backup if recovery is needed

## Import a DBX connection bundle

Import a plaintext or encrypted DBX export into local encrypted connection storage without connecting to any database:

```bash
chmod 600 connections.json
dbx connections import --file connections.json --json
# Review the preview, then explicitly apply:
dbx connections import --file connections.json --yes --json
```

Without `--yes`, import is a dry run. JSON output includes `dry_run`, `input_count`, `imported_count` (the number that would be added during preview), `skipped_count`, tunnel-profile counts, and warnings; it never includes credentials. CLI also accepts a non-interactive secure pipe with `--file -`.

- Accepts a plain DBX bundle with `connections`, optional `layout` and `tunnelProfiles`, legacy connection arrays, and legacy `dbx-config` version 1 exports
- Preserves full supported connection settings and credentials, imports referenced tunnel profiles, and appends sidebar groups/order with new IDs; existing configuration and secrets are not overwritten
- Skips connections with the same normalized name, host, port, database type, and database; equal names with different endpoints/types/databases remain separate (use IDs to select them), while duplicate source IDs and invalid configurations reject the entire batch
- Normally requires an initialized local DBX store and its existing encryption key; `DBX_WEB_URL` and scoped sessions are unsupported, and MCP tool/connection scope applies to preview and import
- Preview is allowed under global read-only mode; applying requires a writable MCP policy and rechecks it in the storage transaction. `--yes` and SQL write flags do not override that policy
- Input is limited to 16 MiB and must be a regular owner-only file on Unix; on Windows, restrict the file's ACL. Encrypted `dbx-encrypted` version 1 exports require a separate protected passphrase file

For an encrypted export, pass the path to an owner-only UTF-8 passphrase file. Use the same arguments for preview and apply:

```bash
chmod 600 connections.json passphrase.txt
dbx connections import --file connections.json --passphrase-file passphrase.txt --json
dbx connections import --file connections.json --passphrase-file passphrase.txt --yes --json
```

A final LF or CRLF is removed from the passphrase file. To avoid a passphrase file, a credential manager may pipe the passphrase to `--passphrase-file -` while the bundle is read from a file; bundle and passphrase cannot both use stdin. No literal passphrase argument is supported. A wrong passphrase or invalid ciphertext fails before any connection is written.

For a completely empty local profile, opt in to `--initialize` on the import command. Preview still creates no encryption key or connections; applying with `--initialize --yes` may provision the profile's encryption key before saving encrypted credentials. Existing connections, legacy files, stored credentials, or a pending/failed security migration block initialization. It never replaces existing keys or weakens MCP policy. Omit `--initialize` for subsequent imports.

Treat plaintext exports as credentials: do not paste their contents into chat, command arguments, logs, or source control. Remove temporary exports when the migration is finished. The import does not test connectivity, copy SQLite/DuckDB files, install drivers, or translate local paths and private-network addresses for the destination machine. Review warnings before using the imported connections.
