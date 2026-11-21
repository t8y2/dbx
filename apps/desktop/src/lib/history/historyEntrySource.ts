import type { HistoryEntry } from "@/lib/backend/api";

export function historyEntrySource(entry: Pick<HistoryEntry, "details_json">): "MCP" | null {
  if (!entry.details_json) return null;
  try {
    const details = JSON.parse(entry.details_json) as { source?: unknown };
    return details.source === "mcp" ? "MCP" : null;
  } catch {
    return null;
  }
}
