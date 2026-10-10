# DBX CLI Command Reference

Use `dbx --help` as the authoritative reference for the installed CLI version.

## Environment and Connections

```bash
dbx doctor --json
dbx capabilities --json
dbx connections list --json
dbx connections get <id-or-name> --json
dbx connections add --file connection.json --json
dbx connections update <id-or-name> --file changes.json --json
dbx connections import --file export.json --json
dbx connections import --file export.json --yes --json
dbx connections remove <id-or-name> --yes --json
```

`doctor` reports connection storage and Desktop bridge health. `capabilities` identifies direct-query and bridge-required database types. Connection listings and details omit secrets. Configuration mutations require an explicit user request and a writable global MCP policy; write flags cannot override it. JSON files must be owner-only on Unix; `--file -` accepts non-terminal stdin. Never put credentials in command arguments. Updates preserve omitted fields and credentials: `{"password":""}` clears the saved password, and null clears `database` or `driver_profile`. Removal requires confirmation and cannot be undone by the CLI.

### Import existing DBX exports

`connections import` is local-only and preview-first: omit `--yes` until the user approves applying the reviewed file. It accepts a plain DBX bundle (`connections`, optional `layout`/`tunnelProfiles`), a legacy array or `dbx-config` object. For an encrypted export, add `--passphrase-file /protected/passphrase.txt`; never put a literal passphrase in argv. A credential manager may pipe it through `--passphrase-file -` when the bundle comes from a file. MCP's corresponding tool accepts only file paths.

Files must be regular, owner-only on Unix, and no larger than 16 MiB for the bundle. Import normally requires the existing encrypted DBX store and key. Only an explicitly approved empty-profile setup may use CLI `--initialize`; it refuses existing connections/credentials or legacy data, and creates no key during preview. Preview is allowed under global read-only; apply still needs writable MCP policy, and both obey tool/connection scopes. It atomically adds full supported settings, referenced tunnel profiles and sidebar layout with new IDs. Exact normalized name/host/port/username/type/database duplicates are skipped; existing secrets are never overwritten. Same-name distinct connections are kept, so use IDs for ambiguous names. Output reports counts/warnings only. Import never tests credentials, connects databases, copies file databases, or installs drivers. Review missing credentials, private addresses and machine-specific paths before use.

## Schema Inspection

```bash
dbx schema list <connection> --json
dbx schema list <connection> --schema <schema> --database <database> --json
dbx schema describe <connection> <table> --json
dbx schema describe <connection> <table> --schema <schema> --database <database> --json
```

## Queries

```bash
dbx query <connection> "SELECT ..." --limit 50 --timeout 10s --json
dbx query <connection> --file ./query.sql --limit 50 --timeout 10s --json
```

Set `DBX_CONNECTION` to omit the connection argument from `query` and `context` commands. If SQL begins with a dash, place `--` before the SQL argument.

Writes require `--allow-writes`. Dangerous SQL such as `DROP`, `TRUNCATE`, and `ALTER` requires both `--allow-writes` and `--allow-dangerous-sql`.

## Prompt Context

```bash
dbx context <connection>
dbx context <connection> --tables users,orders --max-tables 20
```

Prefer a table filter when the task concerns a known subset of the schema.

## DBML and Documentation

```bash
dbx dbml <connection> --out schema.dbml
dbx dbml <connection> --out schema.dbml --notes dbx-docs.json --tables users,orders
dbx docs <connection> --out schema.html --lang en
dbx docs <connection> --out schema.html --notes dbx-docs.json --lang zh-CN
```

Both commands accept `--schema`, `--database`, and `--tables`. An explicitly supplied `--notes` file must exist.

## Desktop Navigation

```bash
dbx open <connection> <table>
dbx open <connection> <table> --schema <schema> --database <database> --json
```

This command requires a running DBX Desktop instance.

## Agent Skill Management

```bash
dbx agent setup
dbx agent status
dbx agent setup --force
dbx agent setup --skills-dir /custom/skills/root
```

The CLI contains the official DBX Skill. `setup` installs or updates its DBX-managed files under `~/.agents/skills/dbx` by default. It refuses to replace unmanaged or locally modified files unless `--force` is supplied. `status` does not modify files.
