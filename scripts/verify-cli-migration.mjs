import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const rustBinary = process.env.DBX_CLI_RUST_BIN;
const legacyBinary = process.env.DBX_CLI_LEGACY_BIN;
const connection = process.env.DBX_CLI_TEST_CONNECTION;

if (!rustBinary || !existsSync(rustBinary)) {
  throw new Error("Set DBX_CLI_RUST_BIN to a release dbx binary before running this test.");
}
if (!legacyBinary || !existsSync(legacyBinary)) {
  throw new Error("Set DBX_CLI_LEGACY_BIN to the legacy TypeScript dbx binary before running this test.");
}
if (!connection) {
  throw new Error("Set DBX_CLI_TEST_CONNECTION to a safe test connection name before running this test.");
}

function run(binary, args, extraEnv = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value == null) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(binary, args, { encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function jsonOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function compareJsonCommand(name, args, compare = (legacy, rust) => assert.deepEqual(rust, legacy)) {
  const legacy = jsonOutput(run(legacyBinary, args));
  const rust = jsonOutput(run(rustBinary, args));
  compare(legacy, rust);
  console.log(`PASS ${name}`);
}

function normalizeRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? value : String(value)])));
}

const version = run(rustBinary, ["--version"]);
assert.equal(version.status, 0);
assert.match(version.stdout, /^\d+\.\d+\.\d+$/);
assert.equal(run(legacyBinary, ["--version"]).status, 0);
console.log("PASS version");

assert.equal(run(rustBinary, ["--help"]).status, 0);
assert.match(run(rustBinary, ["--help"]).stdout, /dbx query/);
assert.match(run(legacyBinary, ["--help"]).stdout, /dbx query/);
console.log("PASS help");

compareJsonCommand("capabilities", ["capabilities", "--json"], (legacy, rust) => {
  assert.deepEqual(Object.keys(rust).sort(), Object.keys(legacy).sort());
  assert.ok(rust.directQueryTypes.includes("postgres"));
  assert.ok(rust.bridgeRequiredTypes.includes("oracle"));
});

compareJsonCommand("connections", ["connections", "list", "--json"], (legacy, rust) => {
  assert.deepEqual(rust.connections, legacy.connections);
});

compareJsonCommand("schema list", ["schema", "list", connection, "--json"], (legacy, rust) => {
  assert.equal(rust.connection, legacy.connection);
  assert.ok(rust.tables.length >= legacy.tables.length);
  assert.deepEqual(rust.tables.slice(0, legacy.tables.length), legacy.tables);
});

const schema = jsonOutput(run(rustBinary, ["schema", "list", connection, "--json"]));
const table = schema.tables[0]?.name;
if (!table) throw new Error(`No table found in ${connection}`);

compareJsonCommand("schema describe", ["schema", "describe", connection, table, "--json"], (legacy, rust) => {
  assert.equal(rust.connection, legacy.connection);
  assert.equal(rust.table, legacy.table);
  assert.deepEqual(
    rust.columns.map(({ name, is_nullable, column_default, is_primary_key, enum_values }) => ({ name, is_nullable, column_default, is_primary_key, enum_values: enum_values ?? null })),
    legacy.columns.map(({ name, is_nullable, column_default, is_primary_key, enum_values }) => ({ name, is_nullable, column_default, is_primary_key, enum_values: enum_values ?? null })),
  );
});

compareJsonCommand("query", ["query", connection, "select 1 as dbx_cli_migration_check", "--json"], (legacy, rust) => {
  assert.deepEqual(rust.columns, legacy.columns);
  assert.deepEqual(normalizeRows(rust.rows), normalizeRows(legacy.rows));
  assert.equal(rust.row_count, legacy.row_count);
});

const temporaryDirectory = mkdtempSync(join(tmpdir(), "dbx-cli-migration-"));
const sqlFile = join(temporaryDirectory, "query.sql");
writeFileSync(sqlFile, "select 1 as dbx_cli_file_check", "utf8");
try {
  compareJsonCommand("file query", ["query", connection, "--file", sqlFile, "--json"], (legacy, rust) => {
    assert.deepEqual(rust.columns, legacy.columns);
    assert.deepEqual(normalizeRows(rust.rows), normalizeRows(legacy.rows));
    assert.equal(rust.row_count, legacy.row_count);
  });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

const context = run(rustBinary, ["context", connection, "--max-tables", "1"]);
assert.equal(context.status, 0, context.stderr);
assert.match(context.stdout, /Connection:/);
assert.match(context.stdout, /## /);
console.log("PASS context");

const contextJson = jsonOutput(run(rustBinary, ["context", "--tables", table, "--json"], { DBX_CONNECTION: connection }));
assert.equal(contextJson.connection, connection);
assert.equal(contextJson.tables.length, 1);
assert.equal(contextJson.tables[0].name.toLowerCase(), table.toLowerCase());
assert.equal(typeof contextJson.truncated, "boolean");
console.log("PASS DBX_CONNECTION context");

const defaultConnectionQuery = jsonOutput(run(rustBinary, ["query", "select 1 as default_connection", "--json"], { DBX_CONNECTION: connection }));
assert.equal(defaultConnectionQuery.connection, connection);
assert.equal(String(defaultConnectionQuery.rows[0].default_connection), "1");
console.log("PASS DBX_CONNECTION query");

const formatAlias = jsonOutput(run(rustBinary, ["query", connection, "select 1 as format_alias", "--format", "json"]));
assert.equal(String(formatAlias.rows[0].format_alias), "1");
console.log("PASS format json alias");

const csv = run(rustBinary, ["query", connection, "select 'a,b' as csv_value", "--format", "csv"]);
assert.equal(csv.status, 0, csv.stderr);
assert.match(csv.stdout, /^csv_value\n"a,b"$/);
console.log("PASS csv escaping");

const limited = jsonOutput(
  run(rustBinary, ["query", connection, "select 1 as n union all select 2 union all select 3", "--limit", "2", "--json"]),
);
assert.equal(limited.rows.length, 2);
assert.equal(limited.row_count, 2);
console.log("PASS query limit");

const doubleDash = jsonOutput(run(rustBinary, ["query", connection, "--json", "--", "-- comment\nselect 1 as double_dash"]));
assert.equal(String(doubleDash.rows[0].double_dash), "1");
console.log("PASS double dash SQL");

const doctor = jsonOutput(run(rustBinary, ["doctor", "--json"]));
for (const key of ["appDataDir", "dbPath", "loadConnectionsOk", "directQueryTypes", "bridgeRequiredTypes"]) assert.ok(key in doctor);
console.log("PASS doctor");

for (const [name, args, code] of [
  ["unknown option", ["connections", "list", "--wat", "--json"], "UNKNOWN_OPTION"],
  ["missing option value", ["schema", "list", connection, "--schema", "--json"], "INVALID_OPTION"],
  ["missing connection", ["schema", "list", "missing-db", "--json"], "CONNECTION_NOT_FOUND"],
  ["blocked write", ["query", connection, "update users set value = 1", "--json"], "SQL_BLOCKED"],
  ["dangerous requires writes", ["query", connection, "drop table users", "--allow-dangerous-sql", "--json"], "INVALID_OPTION"],
  ["dangerous blocked", ["query", connection, "drop table users", "--allow-writes", "--json"], "SQL_BLOCKED"],
  ["invalid format", ["connections", "list", "--format", "yaml", "--json"], "INVALID_OPTION"],
  ["invalid limit", ["query", connection, "select 1", "--limit", "0", "--json"], "INVALID_OPTION"],
  ["invalid timeout", ["query", connection, "select 1", "--timeout", "later", "--json"], "INVALID_OPTION"],
  ["invalid max tables", ["context", connection, "--max-tables", "nope", "--json"], "INVALID_OPTION"],
  ["unexpected positional", ["connections", "list", "extra", "--json"], "INVALID_ARGUMENT"],
]) {
  const result = run(rustBinary, args);
  assert.equal(result.status, 1, `${name}: ${result.stdout}`);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  console.log(`PASS ${name}`);
}

const missingDefault = run(rustBinary, ["query", "select 1", "--json"], { DBX_CONNECTION: null });
assert.equal(missingDefault.status, 1);
assert.equal(JSON.parse(missingDefault.stderr).error.code, "INVALID_ARGUMENT");
console.log("PASS missing default connection");

const temporaryConflictDirectory = mkdtempSync(join(tmpdir(), "dbx-cli-migration-conflict-"));
const conflictFile = join(temporaryConflictDirectory, "query.sql");
writeFileSync(conflictFile, "select 1", "utf8");
try {
  const conflict = run(rustBinary, ["query", connection, "select 2", "--file", conflictFile, "--json"]);
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stderr).error.code, "INVALID_ARGUMENT");
  console.log("PASS inline and file conflict");
} finally {
  rmSync(temporaryConflictDirectory, { recursive: true, force: true });
}

console.log("CLI migration matrix passed.");
