import type { HistoryConnectionFilter, HistoryDatabaseFilter, HistoryEntry, HistorySearchRequest } from "@/lib/backend/api";
import { resolveHistoryActivityKind } from "@/lib/history/historyActivityKind";

function matchesConnection(entry: HistoryEntry, connection: HistoryConnectionFilter): boolean {
  if (connection.connection_id) return entry.connection_id === connection.connection_id;
  return !entry.connection_id && entry.connection_name === connection.connection_name;
}

function matchesDatabase(entry: HistoryEntry, database: HistoryDatabaseFilter): boolean {
  return entry.database === database.database && matchesConnection(entry, database);
}

// Apply the active filters to live entries so local insertion matches backend search semantics.
export function historyEntryMatchesSearch(entry: HistoryEntry, request: HistorySearchRequest): boolean {
  if (request.connections.length > 0 && !request.connections.some((connection) => matchesConnection(entry, connection))) return false;
  if (request.databases.length > 0 && !request.databases.some((database) => matchesDatabase(entry, database))) return false;
  if (request.activity_kind && resolveHistoryActivityKind(entry) !== request.activity_kind) return false;
  if (request.success !== undefined && entry.success !== request.success) return false;

  const executedAt = new Date(entry.executed_at).getTime();
  if (request.started_at && executedAt < new Date(request.started_at).getTime()) return false;
  if (request.ended_at && executedAt > new Date(request.ended_at).getTime()) return false;

  const query = request.search_text.trim().toLowerCase();
  if (!query) return true;
  return [entry.sql, entry.connection_name, entry.database, entry.operation, entry.target].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
}
