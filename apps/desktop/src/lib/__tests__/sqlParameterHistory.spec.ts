import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqlParameterHistory, MAX_SQL_PARAMETER_HISTORY, rememberSqlParameterValue } from "../sqlParameterHistory";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe("sqlParameterHistory", () => {
  it("stores recent values by parameter name", () => {
    rememberSqlParameterValue("start_date", { kind: "string", value: "2026-01-01" });
    rememberSqlParameterValue("start_date", { kind: "string", value: "2026-01-02" });

    expect(loadSqlParameterHistory("start_date")).toEqual([
      { kind: "string", value: "2026-01-02" },
      { kind: "string", value: "2026-01-01" },
    ]);
  });

  it("deduplicates by type and value and moves the latest value to the front", () => {
    rememberSqlParameterValue("min_id", { kind: "number", value: "1" });
    rememberSqlParameterValue("min_id", { kind: "number", value: "2" });
    rememberSqlParameterValue("min_id", { kind: "number", value: "1" });

    expect(loadSqlParameterHistory("min_id")).toEqual([
      { kind: "number", value: "1" },
      { kind: "number", value: "2" },
    ]);
  });

  it("matches parameter names case-insensitively and limits history size", () => {
    for (let i = 0; i < MAX_SQL_PARAMETER_HISTORY + 2; i += 1) {
      rememberSqlParameterValue("UserId", { kind: "number", value: String(i) });
    }

    const history = loadSqlParameterHistory("userId");
    expect(history).toHaveLength(MAX_SQL_PARAMETER_HISTORY);
    expect(history[0]).toEqual({ kind: "number", value: String(MAX_SQL_PARAMETER_HISTORY + 1) });
    expect(history.at(-1)).toEqual({ kind: "number", value: "2" });
  });
});
