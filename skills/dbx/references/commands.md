# DBX CLI Command Reference

Use `dbx --help` as the authoritative reference for the installed CLI version.

## Environment and Connections

```bash
dbx doctor --json
dbx capabilities --json
dbx connections list --json
```

`doctor` reports connection storage and Desktop bridge health. `capabilities` identifies direct-query and bridge-required database types. Connection listings omit secrets.

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
