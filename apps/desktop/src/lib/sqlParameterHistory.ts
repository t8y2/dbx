import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/safeStorage";
import type { SqlParameterInput } from "@/lib/sqlParameters";

const STORAGE_KEY = "dbx-sql-parameter-history";
export const MAX_SQL_PARAMETER_HISTORY = 8;

interface StoredSqlParameterHistory {
  version: 1;
  parameters: Record<string, SqlParameterInput[]>;
}

function emptyHistory(): StoredSqlParameterHistory {
  return { version: 1, parameters: {} };
}

function readHistory(): StoredSqlParameterHistory {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSqlParameterHistory>;
    if (parsed.version !== 1 || !parsed.parameters || typeof parsed.parameters !== "object") return emptyHistory();
    return { version: 1, parameters: parsed.parameters };
  } catch {
    return emptyHistory();
  }
}

function writeHistory(history: StoredSqlParameterHistory) {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(history));
}

function normalizeParameterName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeInput(input: SqlParameterInput): SqlParameterInput | null {
  if (input.kind === "null") return { kind: "null", value: "NULL" };
  const value = input.value.trim();
  if (!value) return null;
  return { kind: input.kind, value };
}

export function loadSqlParameterHistory(name: string): SqlParameterInput[] {
  return (readHistory().parameters[normalizeParameterName(name)] ?? []).slice(0, MAX_SQL_PARAMETER_HISTORY);
}

export function rememberSqlParameterValue(name: string, input: SqlParameterInput): SqlParameterInput[] {
  const normalized = normalizeInput(input);
  if (!normalized) return loadSqlParameterHistory(name);

  const history = readHistory();
  const key = normalizeParameterName(name);
  const previous = history.parameters[key] ?? [];
  history.parameters[key] = [normalized, ...previous.filter((entry) => entry.value !== normalized.value || entry.kind !== normalized.kind)].slice(0, MAX_SQL_PARAMETER_HISTORY);
  writeHistory(history);
  return history.parameters[key];
}

export function rememberSqlParameterValues(values: Record<string, SqlParameterInput>): Record<string, SqlParameterInput[]> {
  const result: Record<string, SqlParameterInput[]> = {};
  for (const [name, input] of Object.entries(values)) {
    result[name] = rememberSqlParameterValue(name, input);
  }
  return result;
}
