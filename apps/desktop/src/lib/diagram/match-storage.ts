import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

function matchStorageKey(type: "match-confirms" | "match-ignores" | "match-rules", connectionId: string, database: string, schema: string): string {
  return ["dbx", "diagram", type, "v1", connectionId, database, schema].join(":");
}

export function loadMatchConfirms(connectionId: string, database: string, schema: string): string[] {
  const key = matchStorageKey("match-confirms", connectionId, database, schema);
  try {
    return JSON.parse(safeLocalStorageGet(key) || "[]");
  } catch {
    return [];
  }
}

export function saveMatchConfirms(ids: string[], connectionId: string, database: string, schema: string): void {
  const key = matchStorageKey("match-confirms", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(ids));
}

export function loadMatchIgnores(connectionId: string, database: string, schema: string): string[] {
  const key = matchStorageKey("match-ignores", connectionId, database, schema);
  try {
    return JSON.parse(safeLocalStorageGet(key) || "[]");
  } catch {
    return [];
  }
}

export function saveMatchIgnores(ids: string[], connectionId: string, database: string, schema: string): void {
  const key = matchStorageKey("match-ignores", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(ids));
}

export function loadMatchRules(connectionId: string, database: string, schema: string): MatchRule[] {
  const key = matchStorageKey("match-rules", connectionId, database, schema);
  try {
    return JSON.parse(safeLocalStorageGet(key) || "[]");
  } catch {
    return [];
  }
}

export function saveMatchRules(rules: MatchRule[], connectionId: string, database: string, schema: string): void {
  const key = matchStorageKey("match-rules", connectionId, database, schema);
  safeLocalStorageSet(key, JSON.stringify(rules));
}

export function isAutoMatchEnabled(): boolean {
  return safeLocalStorageGet("dbx:diagram:match-enabled") !== "false";
}

export function setAutoMatchEnabled(enabled: boolean): void {
  safeLocalStorageSet("dbx:diagram:match-enabled", String(enabled));
}

export interface MatchRule {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  priority: number;
}
