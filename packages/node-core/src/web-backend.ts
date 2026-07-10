import type { ConnectionConfig } from "./connections.js";
import type { TableInfo, ColumnInfo, QueryOptions, QueryResult } from "./database.js";
import {
  collectionListToTableInfos,
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  inferMongoColumns,
  mongoCollectionStatsToQueryResult,
  mongoDocumentsToQueryResult,
  parseMongoAggregateCommand,
  parseMongoCollectionStatsCommand,
  parseMongoCountDocumentsCommand,
  parseMongoFindCommand,
  parseMongoGetIndexesCommand,
  parseMongoVersionCommand,
  parseMongoWriteCommand,
  type CollectionInfo,
  type MongoWriteCommand,
} from "./database.js";
import type { RedisCommandOptions, RedisCommandResult } from "./redis-command.js";
import { sqlSafetyFromEnv } from "./sql-safety.js";

let sessionCookie: string | null = null;
let authChecked = false;

interface AuthCheckResponse {
  authenticated: boolean;
  required: boolean;
  setup_required: boolean;
}

function baseUrl(): string {
  return process.env.DBX_WEB_URL!.replace(/\/+$/, "");
}

function webPassword(): string {
  return process.env.DBX_WEB_PASSWORD || "";
}

function extractSessionCookie(setCookie: string | null): string | null {
  const match = setCookie?.match(/dbx_session=([^;]+)/);
  return match?.[1] ?? null;
}

async function checkAuth(): Promise<AuthCheckResponse> {
  const res = await fetch(`${baseUrl()}/api/auth/check`, {
    method: "GET",
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(`Authentication check failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as AuthCheckResponse;
}

async function ensureAuth(): Promise<void> {
  if (sessionCookie) return;
  if (authChecked) return;

  const auth = await checkAuth();
  if (auth.setup_required) {
    throw new Error("DBX Web password setup is required before MCP Web mode can access APIs.");
  }
  if (!auth.required || auth.authenticated) {
    authChecked = true;
    return;
  }

  const password = webPassword();
  if (!password) {
    throw new Error("DBX Web authentication is required. Set DBX_WEB_PASSWORD for MCP Web mode.");
  }

  const res = await fetch(`${baseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });

  if (!res.ok) {
    throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
  }

  sessionCookie = extractSessionCookie(res.headers.get("set-cookie"));
  if (!sessionCookie) {
    throw new Error("Authentication failed: DBX Web did not return a session cookie.");
  }
  authChecked = true;
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
  let res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: headers(init?.headers as Record<string, string> | undefined),
  });
  if (res.status === 401 && sessionCookie && webPassword()) {
    sessionCookie = null;
    authChecked = false;
    await ensureAuth();
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: headers(init?.headers as Record<string, string> | undefined),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API request ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }
  return res;
}

export function resetWebAuthForTests(): void {
  sessionCookie = null;
  authChecked = false;
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

export async function removeConnectionById(id: string): Promise<boolean> {
  const connection = await loadConnections().then((cs) => cs.find((c) => c.id === id));
  if (!connection) return false;
  await apiFetch(`/api/connection/delete?id=${encodeURIComponent(id)}`, { method: "DELETE" });
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
    const collections = (await res.json()) as Array<string | CollectionInfo>;
    return collectionListToTableInfos(collections);
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
    if (parseMongoVersionCommand(sql)) {
      const res = await apiFetch("/api/mongo/server-version", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
        }),
      });
      const version = (await res.json()) as string;
      return { columns: ["version"], rows: [{ version }], row_count: 1 };
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
          projection: find.projection,
          sort: find.sort,
        }),
      });
      const result = (await res.json()) as { documents: unknown[]; total: number };
      return mongoDocumentsToQueryResult(result.documents.slice(0, options?.maxRows ?? result.documents.length), result.total);
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
    const getIndexes = parseMongoGetIndexesCommand(sql);
    if (getIndexes) {
      const res = await apiFetch("/api/mongo/aggregate-documents", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
          collection: getIndexes.collection,
          pipelineJson: '[{"$indexStats":{}}]',
          maxRows: options?.maxRows ?? 100,
        }),
      });
      const result = (await res.json()) as { documents: unknown[]; total: number };
      return mongoDocumentsToQueryResult(result.documents.slice(0, options?.maxRows ?? result.documents.length), result.total);
    }
    const collectionStats = parseMongoCollectionStatsCommand(sql);
    if (collectionStats) {
      const res = await apiFetch("/api/mongo/collection-stats", {
        method: "POST",
        body: JSON.stringify({
          connectionId: config.id,
          database: config.database || "",
          collection: collectionStats.collection,
          scale: collectionStats.scale,
        }),
      });
      const result = (await res.json()) as Record<string, unknown>;
      return mongoCollectionStatsToQueryResult(collectionStats.metric, result);
    }
    const write = parseMongoWriteCommand(sql);
    if (write) {
      const safety = evaluateMongoWriteSafety(write, sqlSafetyFromEnv());
      if (!safety.allowed) throw new Error(safety.reason);
      const result = await executeMongoWrite(config, write);
      if (write.kind === "createIndex") {
        return { columns: ["name"], rows: [{ name: result.indexName ?? "" }], row_count: 1 };
      }
      if (write.kind === "dropIndex" || write.kind === "dropIndexes") {
        return { columns: ["name"], rows: (result.droppedNames ?? []).map((name) => ({ name })), row_count: result.affectedRows };
      }
      return { columns: [], rows: [], row_count: result.affectedRows };
    }
    throw new Error(
      'Use MongoDB shell-style commands, for example: db.projects.find({}).limit(100), db.version(), db.projects.countDocuments({}), db.projects.count({}), db.projects.getIndexes(), db.projects.dataSize(), db.projects.storageSize(1024), db.projects.totalIndexSize(), db.projects.stats(), db.projects.createIndex({...}), db.projects.dropIndex("name"), db.projects.dropIndexes(), db.projects.drop(), db.projects.insertOne({...}), db.projects.updateOne({...}, {$set: {...}}), or db.projects.deleteOne({...})',
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

export async function executeRedisCommand(config: ConnectionConfig, db: number, command: string, options?: RedisCommandOptions): Promise<RedisCommandResult> {
  if (config.db_type !== "redis") {
    throw new Error("Connection is not Redis.");
  }
  await ensureConnected(config);
  const res = await apiFetch("/api/redis/execute-command", {
    method: "POST",
    body: JSON.stringify({
      connectionId: config.id,
      db,
      command,
      skipSafetyCheck: options?.skipSafetyCheck ?? false,
    }),
  });
  return (await res.json()) as RedisCommandResult;
}

async function executeMongoWrite(config: ConnectionConfig, command: MongoWriteCommand): Promise<{ affectedRows: number; indexName?: string; droppedNames?: string[] }> {
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
    return { affectedRows: result.affected_rows };
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
    return { affectedRows: result.affected_rows };
  }
  if (command.kind === "createIndex") {
    const res = await apiFetch("/api/mongo/create-index", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.id,
        database: config.database || "",
        collection: command.collection,
        keysJson: command.keys,
        optionsJson: command.options,
      }),
    });
    const result = (await res.json()) as { name: string };
    return { affectedRows: 1, indexName: result.name };
  }
  if (command.kind === "dropIndex" || command.kind === "dropIndexes") {
    const res = await apiFetch("/api/mongo/drop-indexes", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.id,
        database: config.database || "",
        collection: command.collection,
        indexesJson: command.kind === "dropIndex" ? command.index : command.indexes,
        single: command.kind === "dropIndex",
      }),
    });
    const result = (await res.json()) as { dropped_names: string[]; affected_rows: number };
    return { affectedRows: result.affected_rows, droppedNames: result.dropped_names };
  }
  if (command.kind === "dropCollection") {
    await apiFetch("/api/mongo/drop-collection", {
      method: "POST",
      body: JSON.stringify({
        connectionId: config.id,
        database: config.database || "",
        collection: command.collection,
      }),
    });
    return { affectedRows: 1 };
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
  return { affectedRows: result.affected_rows };
}
