import type { ConnectionConfig } from "./connections.js";
import type { TableInfo, ColumnInfo, QueryOptions, QueryResult } from "./database.js";
import {
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  inferMongoColumns,
  mongoDocumentsToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoWriteCommand,
  type MongoWriteCommand,
} from "./database.js";
import { sqlSafetyFromEnv } from "./sql-safety.js";

const baseUrl = process.env.DBX_WEB_URL!.replace(/\/+$/, "");
const password = process.env.DBX_WEB_PASSWORD || "";

let sessionCookie: string | null = null;

async function ensureAuth(): Promise<void> {
  if (sessionCookie) return;
  if (!password) return; // no password set, assume no auth required

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });

  if (!res.ok) {
    throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
  }

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const match = setCookie.match(/dbx_session=([^;]+)/);
    if (match) {
      sessionCookie = match[1];
    }
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (sessionCookie) {
    h["Cookie"] = `dbx_session=${sessionCookie}`;
  }
  return h;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureAuth();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: headers(init?.headers as Record<string, string> | undefined),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API request ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res;
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  const res = await apiFetch("/api/connection/list");
  return res.json();
}

export async function findConnection(name: string): Promise<ConnectionConfig | undefined> {
  const connections = await loadConnections();
  return connections.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export async function addConnection(config: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig> {
  const res = await apiFetch("/api/connection/save", {
    method: "POST",
    body: JSON.stringify({ configs: [config] }),
  });
  const saved = (await res.json()) as ConnectionConfig;
  return saved;
}

export async function removeConnection(name: string): Promise<boolean> {
  const connection = await findConnection(name);
  if (!connection) return false;
  await apiFetch(`/api/connection/delete?id=${encodeURIComponent(connection.id)}`, { method: "DELETE" });
  return true;
}

async function ensureConnected(config: ConnectionConfig): Promise<void> {
  await apiFetch("/api/connection/connect", {
    method: "POST",
    body: JSON.stringify({ config }),
  });
}

export async function listTables(config: ConnectionConfig, schema?: string): Promise<TableInfo[]> {
  await ensureConnected(config);
  if (config.db_type === "mongodb") {
    const res = await apiFetch("/api/mongo/list-collections", {
      method: "POST",
      body: JSON.stringify({ connectionId: config.id, database: config.database || "" }),
    });
    const collections = (await res.json()) as string[];
    return collections.map((name) => ({ name, type: "COLLECTION" }));
  }
  const params = new URLSearchParams({
    connection_id: config.id,
    database: config.database || "",
    schema: schema || "",
  });
  const res = await apiFetch(`/api/schema/tables?${params}`);
  return res.json();
}

export async function describeTable(config: ConnectionConfig, table: string, schema?: string): Promise<ColumnInfo[]> {
  await ensureConnected(config);
  if (config.db_type === "mongodb") {
    const res = await apiFetch("/api/mongo/find-documents", {
      method: "POST",
      body: JSON.stringify({ connectionId: config.id, database: config.database || "", collection: table, skip: 0, limit: 20, filter: "{}" }),
    });
    const result = (await res.json()) as { documents: unknown[]; total: number };
    return inferMongoColumns(result.documents);
  }
  const params = new URLSearchParams({
    connection_id: config.id,
    database: config.database || "",
    schema: schema || "",
    table,
  });
  const res = await apiFetch(`/api/schema/columns?${params}`);
  return res.json();
}

export async function executeQuery(config: ConnectionConfig, sql: string, options?: QueryOptions): Promise<QueryResult> {
  await ensureConnected(config);
  if (config.db_type === "mongodb") {
    const find = parseMongoFindCommand(sql);
    if (find) {
      const res = await apiFetch("/api/mongo/find-documents", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
          collection: find.collection,
          skip: find.skip,
          limit: find.limit,
          filter: find.filter,
          sort: find.sort,
        }),
      });
      const result = (await res.json()) as { documents: unknown[]; total: number };
      return mongoDocumentsToQueryResult(result.documents.slice(0, options?.maxRows ?? result.documents.length), result.total);
    }
    const count = parseMongoCountDocumentsCommand(sql);
    if (count) {
      const res = await apiFetch("/api/mongo/find-documents", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
          collection: count.collection,
          skip: 0,
          limit: 1,
          filter: count.filter,
        }),
      });
      const result = (await res.json()) as { documents: unknown[]; total: number };
      return { columns: ["count"], rows: [{ count: result.total }], row_count: 1 };
    }
    const aggregate = parseMongoAggregateCommand(sql);
    if (aggregate) {
      const safety = evaluateMongoAggregateSafety(aggregate, sqlSafetyFromEnv());
      if (!safety.allowed) throw new Error(safety.reason);
      const res = await apiFetch("/api/mongo/aggregate-documents", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
          collection: aggregate.collection,
          pipelineJson: aggregate.pipeline,
          maxRows: options?.maxRows ?? 100,
        }),
      });
      const result = (await res.json()) as { documents: unknown[]; total: number };
      return mongoDocumentsToQueryResult(result.documents.slice(0, options?.maxRows ?? result.documents.length), result.total);
    }
    const write = parseMongoWriteCommand(sql);
    if (write) {
      const safety = evaluateMongoWriteSafety(write, sqlSafetyFromEnv());
      if (!safety.allowed) throw new Error(safety.reason);
      const affected = await executeMongoWrite(config, write);
      return { columns: [], rows: [], row_count: affected };
    }
    throw new Error(
      "Use MongoDB shell-style commands, for example: db.projects.find({}).limit(100), db.projects.countDocuments({}), db.projects.insertOne({...}), db.projects.updateOne({...}, {$set: {...}}), or db.projects.deleteOne({...})",
    );
  }
  const res = await apiFetch("/api/query/execute", {
    method: "POST",
    body: JSON.stringify({
      connectionId: config.id,
      database: config.database || "",
      sql,
    }),
  });
  const data = (await res.json()) as { columns: string[]; rows: unknown[][] };
  const rows = data.rows.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    data.columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  });
  const limitedRows = rows.slice(0, options?.maxRows ?? rows.length);
  return { columns: data.columns, rows: limitedRows, row_count: limitedRows.length };
}

async function executeMongoWrite(config: ConnectionConfig, command: MongoWriteCommand): Promise<number> {
  if (command.kind === "insert") {
    const res = await apiFetch("/api/mongo/insert-documents", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.id,
        database: config.database || "",
        collection: command.collection,
        docsJson: command.docsJson,
      }),
    });
    const result = (await res.json()) as { affected_rows: number };
    return result.affected_rows;
  }
  if (command.kind === "update") {
    const res = await apiFetch("/api/mongo/update-documents", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.id,
        database: config.database || "",
        collection: command.collection,
        filterJson: command.filter,
        updateJson: command.update,
        many: command.many,
      }),
    });
    const result = (await res.json()) as { affected_rows: number };
    return result.affected_rows;
  }
  const res = await apiFetch("/api/mongo/delete-documents", {
    method: "POST",
    body: JSON.stringify({
      connectionId: config.id,
      database: config.database || "",
      collection: command.collection,
      filterJson: command.filter,
      many: command.many,
    }),
  });
  const result = (await res.json()) as { affected_rows: number };
  return result.affected_rows;
}
