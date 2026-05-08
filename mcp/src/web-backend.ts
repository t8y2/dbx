import type { ConnectionConfig } from "./connections.js";
import type { TableInfo, ColumnInfo, QueryResult } from "./database.js";

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
  const params = new URLSearchParams({
    connection_id: config.id,
    database: config.database || "",
    schema: schema || "",
    table,
  });
  const res = await apiFetch(`/api/schema/columns?${params}`);
  return res.json();
}

export async function executeQuery(config: ConnectionConfig, sql: string): Promise<QueryResult> {
  await ensureConnected(config);
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
  return { columns: data.columns, rows, row_count: rows.length };
}
