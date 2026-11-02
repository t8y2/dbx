export type AiSqlApplyTargetMode = "current" | "first" | "new";

export interface AiSqlTargetTabCandidate {
  id: string;
  mode?: string;
  connectionId?: string;
  database?: string;
  schema?: string;
  objectSource?: unknown;
  readOnly?: boolean;
}

export function normalizeAiSqlApplyTargetMode(value: unknown, fallback: AiSqlApplyTargetMode = "current"): AiSqlApplyTargetMode {
  return value === "current" || value === "first" || value === "new" ? value : fallback;
}

/**
 * Resolves the query tab ID an AI-initiated SQL action should target based on
 * the user's `aiSqlApplyTargetMode` preference (#12438).
 *
 * - "current": If the active tab is an editable query tab matching the connection,
 *   database, and schema, use it. Otherwise fall back to the first matching tab,
 *   or return null to create a new tab.
 * - "first": Always use the first matching query tab, or return null to create one.
 * - "new": Always return null to force creating a new query tab.
 *
 * Returns "" if target has no connectionId (no-connection error condition).
 * Returns null if a new tab should be created on demand.
 * Returns the matching tab's ID if found.
 */
export function resolveAiSqlTargetTabId<T extends AiSqlTargetTabCandidate>(tabs: readonly T[], activeTabId: string | null | undefined, target: { connectionId?: string; database?: string; schema?: string }, mode: AiSqlApplyTargetMode = "current"): string | null {
  if (!target.connectionId) return "";
  const database = target.database || "";
  const schema = target.schema || undefined;

  const isMatch = (tab: T) => tab.mode === "query" && !tab.objectSource && !tab.readOnly && tab.connectionId === target.connectionId && (tab.database || "") === database && (tab.schema || undefined) === schema;

  if (mode !== "new") {
    if (mode === "current" && activeTabId) {
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (activeTab && isMatch(activeTab)) {
        return activeTab.id;
      }
    }

    const existing = tabs.find(isMatch);
    if (existing) return existing.id;
  }

  return null;
}
