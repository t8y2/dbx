#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildSchemaContext, createBackend, DIRECT_QUERY_TYPES, BRIDGE_REQUIRED_TYPES, evaluateSqlSafety, formatSchemaContext, getDbxDiagnostics, isMainModule, postBridge, type Backend, type DbxDiagnostics, type SqlSafetyOptions } from "@dbx-app/node-core";
import { connectionSummary, csvTable, errorPayload, formatCell, formatErrorMessage, mdTable } from "./cli-format.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  backend?: Backend;
  backendFactory?: (env?: NodeJS.ProcessEnv) => Promise<Backend>;
  env?: NodeJS.ProcessEnv;
  diagnostics?: () => Promise<DbxDiagnostics>;
}

interface ParsedFlags {
  args: string[];
  json: boolean;
  format: "table" | "json" | "csv";
  schema?: string;
  database?: string;
  tables?: string[];
  maxTables?: number;
  maxRows?: number;
  timeoutMs?: number;
  file?: string;
  allowWrites: boolean;
  allowDangerous: boolean;
  help: boolean;
  version: boolean;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function runCli(argv: string[], options: RunOptions = {}): Promise<CliResult> {
  const env = options.env ?? process.env;
  let ownedBackend: Backend | undefined;

  try {
    const flags = parseFlags(argv);
    const args = flags.args;

    if (flags.version) {
      return ok(`${await packageVersion()}\n`);
    }

    if (args.length === 0 || flags.help || args[0] === "help") {
      return ok(`${usage()}\n`);
    }

    const backendFactory = options.backendFactory ?? createBackend;
    const backend = options.backend ?? (ownedBackend = await backendFactory(env));

    if (args[0] === "doctor") {
      ensureArgCount(args, 1, "dbx doctor");
      const diagnostics = await (options.diagnostics ?? getDbxDiagnostics)();
      if (flags.format === "json") return okJson(diagnostics);
      if (flags.format === "csv") {
        return ok(
          csvTable(
            ["check", "value"],
            [
              { check: "appDataDir", value: diagnostics.appDataDir },
              { check: "dbPath", value: diagnostics.dbPath },
              { check: "dbPathExists", value: diagnostics.dbPathExists },
              { check: "connectionsTableExists", value: diagnostics.connectionsTableExists },
              { check: "connectionRowCount", value: diagnostics.connectionRowCount },
              { check: "loadConnectionsOk", value: diagnostics.loadConnectionsOk },
              { check: "loadedConnectionCount", value: diagnostics.loadedConnectionCount },
              { check: "loadConnectionsError", value: diagnostics.loadConnectionsError ?? "" },
              { check: "loadConnectionsHint", value: diagnostics.loadConnectionsHint ?? "" },
              { check: "bridgePortFile", value: diagnostics.bridgePortFile },
              { check: "bridgePortFileExists", value: diagnostics.bridgePortFileExists },
              { check: "bridgeUrl", value: diagnostics.bridgeUrl ?? "" },
            ],
          ),
        );
      }
      return ok(formatDoctor(diagnostics));
    }

    if (args[0] === "capabilities") {
      ensureArgCount(args, 1, "dbx capabilities");
      const payload = {
        directQueryTypes: [...DIRECT_QUERY_TYPES],
        bridgeRequiredTypes: [...BRIDGE_REQUIRED_TYPES],
      };
      if (flags.format === "json") return okJson(payload);
      if (flags.format === "csv") {
        return ok(csvTable(["mode", "type"], [...payload.directQueryTypes.map((type) => ({ mode: "direct", type })), ...payload.bridgeRequiredTypes.map((type) => ({ mode: "bridge", type }))]));
      }
      return ok(
        `${mdTable(
          ["Mode", "Types"],
          [
            ["Direct", payload.directQueryTypes.join(", ")],
            ["Requires DBX Desktop", payload.bridgeRequiredTypes.join(", ")],
          ],
        )}\n`,
      );
    }

    if (args[0] === "connections" && args[1] === "list") {
      ensureArgCount(args, 2, "dbx connections list");
      const connections = (await backend.loadConnections()).map(connectionSummary);
      if (flags.format === "json") return okJson({ connections });
      if (flags.format === "csv") return ok(csvTable(["name", "type", "host", "port", "database"], connections));
      return ok(
        `${mdTable(
          ["Name", "Type", "Host", "Port", "Database"],
          connections.map((c) => [c.name, c.type, c.host, String(c.port), c.database ?? ""]),
        )}\n`,
      );
    }

    if (args[0] === "schema" && args[1] === "list") {
      ensureArgCount(args, 3, "dbx schema list");
      const connectionName = required(args[2], "Connection name is required.");
      const config = await findConnectionOrThrow(backend, connectionName);
      const tables = await backend.listTables(config, flags.schema);
      if (flags.format === "json") return okJson({ connection: connectionName, schema: flags.schema, tables });
      if (flags.format === "csv") return ok(csvTable(["name", "type"], tables));
      return ok(
        `${mdTable(
          ["Table", "Type"],
          tables.map((t) => [t.name, t.type]),
        )}\n`,
      );
    }

    if (args[0] === "schema" && args[1] === "describe") {
      ensureArgCount(args, 4, "dbx schema describe");
      const connectionName = required(args[2], "Connection name is required.");
      const table = required(args[3], "Table name is required.");
      const config = await findConnectionOrThrow(backend, connectionName);
      const columns = await backend.describeTable(config, table, flags.schema);
      if (flags.format === "json") return okJson({ connection: connectionName, schema: flags.schema, table, columns });
      if (flags.format === "csv") {
        return ok(csvTable(["name", "data_type", "is_nullable", "is_primary_key", "column_default", "comment"], columns));
      }
      return ok(
        `${mdTable(
          ["Column", "Type", "Nullable", "Default", "Comment"],
          columns.map((c) => [c.is_primary_key ? `${c.name} (PK)` : c.name, c.data_type, c.is_nullable ? "YES" : "NO", c.column_default ?? "", c.comment ?? ""]),
        )}\n`,
      );
    }

    if (args[0] === "query") {
      const usesDefaultConnection = !!env.DBX_CONNECTION && args.length === (flags.file ? 1 : 2);
      ensureArgCount(args, usesDefaultConnection ? (flags.file ? 1 : 2) : flags.file ? 2 : 3, "dbx query");
      const connectionName = usesDefaultConnection ? env.DBX_CONNECTION! : required(args[1], "Connection name is required.");
      if (flags.file && args[2]) {
        throw new CliError("INVALID_ARGUMENT", "Provide SQL either inline or with --file, not both.");
      }
      const sqlArg = usesDefaultConnection ? args[1] : args[2];
      const sql = flags.file ? await readFile(flags.file, "utf-8") : required(sqlArg, "SQL string or --file is required.");
      const envSafety = sqlSafetyFromCliEnv(env);
      if (flags.allowDangerous && !flags.allowWrites && !envSafety.allowWrites) {
        throw new CliError("INVALID_OPTION", "--allow-dangerous-sql requires --allow-writes.");
      }
      const safetyOptions: SqlSafetyOptions = {
        allowWrites: flags.allowWrites || envSafety.allowWrites,
        allowDangerous: flags.allowDangerous || envSafety.allowDangerous,
      };
      const safety = evaluateSqlSafety(sql, safetyOptions);
      if (!safety.allowed) return fail("SQL_BLOCKED", safety.reason ?? "SQL blocked.", flags.json);
      const config = await findConnectionOrThrow(backend, connectionName);
      const result = await backend.executeQuery(config, sql, { maxRows: flags.maxRows, timeoutMs: flags.timeoutMs });
      if (flags.format === "json") {
        return okJson({ connection: connectionName, columns: result.columns, rows: result.rows, row_count: result.row_count });
      }
      if (flags.format === "csv") return ok(csvTable(result.columns, result.rows));
      if (result.columns.length === 0) return ok(`Query executed. ${result.row_count} row(s) affected.\n`);
      return ok(
        `${mdTable(
          result.columns,
          result.rows.map((row) => result.columns.map((column) => formatCell(row[column]))),
        )}\n\n${result.row_count} row(s)\n`,
      );
    }

    if (args[0] === "context") {
      const usesDefaultConnection = !!env.DBX_CONNECTION && args.length === 1;
      ensureArgCount(args, usesDefaultConnection ? 1 : 2, "dbx context");
      const connectionName = usesDefaultConnection ? env.DBX_CONNECTION! : required(args[1], "Connection name is required.");
      const config = await findConnectionOrThrow(backend, connectionName);
      const context = await buildSchemaContext(backend, config, {
        schema: flags.schema,
        tables: flags.tables,
        maxTables: flags.maxTables,
      });
      if (flags.format === "json") return okJson(context);
      if (flags.format === "csv") throw new CliError("INVALID_OPTION", "CSV format is not supported for dbx context.");
      return ok(`${formatSchemaContext(context)}\n`);
    }

    if (args[0] === "open") {
      ensureArgCount(args, 3, "dbx open");
      const connectionName = required(args[1], "Connection name is required.");
      const table = required(args[2], "Table name is required.");
      const response = await postBridge("/open-table", {
        connection_name: connectionName,
        table,
        schema: flags.schema,
        database: flags.database,
      });
      if (!response.ok) {
        return fail("DBX_NOT_RUNNING", response.text || "DBX is not running. Please start DBX first.", flags.json);
      }
      if (flags.format === "json") return okJson({ opened: true, connection: connectionName, table, schema: flags.schema, database: flags.database });
      if (flags.format === "csv") throw new CliError("INVALID_OPTION", "CSV format is not supported for dbx open.");
      return ok(`Opened ${table} in DBX\n`);
    }

    return fail("USAGE", usage(), flags.json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CliError ? error.code : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "ERROR";
    const wantsJson = argv.includes("--json");
    return fail(code, message, wantsJson);
  } finally {
    await ownedBackend?.close?.().catch(() => {});
  }
}

function parseFlags(argv: string[]): ParsedFlags {
  const args: string[] = [];
  const flags: ParsedFlags = {
    args,
    json: false,
    format: "table",
    allowWrites: false,
    allowDangerous: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--json") {
      flags.json = true;
      flags.format = "json";
    } else if (arg === "--format") flags.format = parseFormat(readOptionValue(argv, ++i, "--format"));
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-V") flags.version = true;
    else if (arg === "--schema") flags.schema = readOptionValue(argv, ++i, "--schema");
    else if (arg === "--database") flags.database = readOptionValue(argv, ++i, "--database");
    else if (arg === "--tables") flags.tables = splitCsv(readOptionValue(argv, ++i, "--tables"));
    else if (arg === "--max-tables") flags.maxTables = parsePositiveInt(readOptionValue(argv, ++i, "--max-tables"), "--max-tables");
    else if (arg === "--limit") flags.maxRows = parsePositiveInt(readOptionValue(argv, ++i, "--limit"), "--limit");
    else if (arg === "--timeout") flags.timeoutMs = parseDurationMs(readOptionValue(argv, ++i, "--timeout"), "--timeout");
    else if (arg === "--file") flags.file = readOptionValue(argv, ++i, "--file");
    else if (arg === "--allow-writes") flags.allowWrites = true;
    else if (arg === "--allow-dangerous-sql") flags.allowDangerous = true;
    else if (arg.startsWith("-")) throw new CliError("UNKNOWN_OPTION", `Unknown option: ${arg}`);
    else args.push(arg);
  }

  return flags;
}

function parseFormat(value: string): "table" | "json" | "csv" {
  if (value === "table" || value === "json" || value === "csv") return value;
  throw new CliError("INVALID_OPTION", "--format must be one of: table, json, csv.");
}

function ensureArgCount(args: string[], count: number, command: string): void {
  if (args.length !== count) {
    throw new CliError("INVALID_ARGUMENT", `${command} expects ${count - 1} argument(s); received ${args.length - 1}.`);
  }
}

function readOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new CliError("INVALID_OPTION", `${option} requires a value.`);
  }
  return value;
}

function parsePositiveInt(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError("INVALID_OPTION", `${option} must be a positive integer.`);
  }
  return parsed;
}

function parseDurationMs(value: string, option: string): number {
  const match = value.match(/^(\d+)(ms|s|m)?$/);
  if (!match) {
    throw new CliError("INVALID_OPTION", `${option} must be a positive duration such as 500ms, 10s, or 1m.`);
  }
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) {
    throw new CliError("INVALID_OPTION", `${option} must be a positive duration such as 500ms, 10s, or 1m.`);
  }
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  return amount * 60_000;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function sqlSafetyFromCliEnv(env: NodeJS.ProcessEnv): Required<Pick<SqlSafetyOptions, "allowWrites" | "allowDangerous">> {
  return {
    allowWrites: parseBooleanEnv(env.DBX_MCP_ALLOW_WRITES),
    allowDangerous: parseBooleanEnv(env.DBX_MCP_ALLOW_DANGEROUS_SQL),
  };
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function findConnectionOrThrow(backend: Backend, name: string) {
  const config = await backend.findConnection(name);
  if (!config) throw new CliError("CONNECTION_NOT_FOUND", `Connection "${name}" not found.`);
  return config;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function okJson(payload: unknown): CliResult {
  return ok(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(code: string, message: string, json: boolean): CliResult {
  const text = json ? `${JSON.stringify(errorPayload(code, message), null, 2)}\n` : `${formatErrorMessage(code, message)}\n`;
  return { exitCode: 1, stdout: "", stderr: text };
}

function usage(): string {
  return [
    "Usage:",
    "  dbx doctor [--json]",
    "  dbx capabilities [--json]",
    "  dbx connections list [--json]",
    "  dbx schema list <connection> [--schema name] [--json]",
    "  dbx schema describe <connection> <table> [--schema name] [--json]",
    "  dbx query <connection> <sql> [--file path] [--limit n] [--timeout 10s] [--allow-writes] [--allow-dangerous-sql] [--json]",
    "  dbx context <connection> [--schema name] [--tables a,b] [--max-tables n] [--json]",
    "  dbx open <connection> <table> [--schema name] [--database name] [--json]",
  ].join("\n");
}

function formatDoctor(diagnostics: DbxDiagnostics): string {
  const rows = [
    ["App data directory", diagnostics.appDataDir],
    ["DBX database", diagnostics.dbPathExists ? `found (${diagnostics.dbPath})` : `missing (${diagnostics.dbPath})`],
    ["Connections table", diagnostics.connectionsTableExists ? `${diagnostics.connectionRowCount} row(s)` : "missing"],
    ["Connection loading", diagnostics.loadConnectionsOk ? `ok (${diagnostics.loadedConnectionCount} loaded)` : `failed (${diagnostics.loadConnectionsError ?? "unknown error"})`],
    ...(diagnostics.loadConnectionsHint ? [["Connection fix", diagnostics.loadConnectionsHint]] : []),
    ["Desktop bridge", diagnostics.bridgePortFileExists ? `available (${diagnostics.bridgeUrl ?? diagnostics.bridgePortFile})` : "not running"],
    ["Direct query types", diagnostics.directQueryTypes.join(", ")],
    ["Bridge-required types", diagnostics.bridgeRequiredTypes.join(", ")],
  ];
  return `${mdTable(["Check", "Value"], rows)}\n`;
}

async function packageVersion(): Promise<string> {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf-8");
  const parsed = JSON.parse(packageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
