// @vitest-environment happy-dom

/**
 * Saved per-table filter/sort defaults (#15569) restore free-form SQL without
 * validating it against the table's current columns. When the first query of a
 * reopen carries saved defaults and fails as an execution error (a filtered or
 * sorted column was dropped/renamed — schema drift), the open paths mirror the
 * #12647 synthetic-row-id degradation: drop the stale defaults and retry once
 * without them. These tests pin the predicate plus the storage round-trip it
 * interacts with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTableDataQueryDefaults, removeTableDataQueryDefaults, saveTableDataQueryDefaults, shouldRetryWithoutTableDataQueryDefaults, type TableDataQueryDefaultsScope } from "@/lib/table/tableDataQueryDefaults";
import type { QueryResult } from "@/types/database";

const scope: TableDataQueryDefaultsScope = { connectionId: "conn-1", database: "db1", schema: "public", tableName: "t1" };

function createLocalStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
  };
}

// The batch executor marks failures with the explicit boolean marker so a
// successful result column literally named "Error" is never mistaken for one
// (see isQueryExecutionErrorResult).
function errorResult(): QueryResult {
  return { columns: [], rows: [['column "gone" does not exist']], total: 0, execution_error: true } as unknown as QueryResult;
}

function okResult(): QueryResult {
  return { columns: [], rows: [], total: 0 } as unknown as QueryResult;
}

describe("shouldRetryWithoutTableDataQueryDefaults (#15569 schema drift)", () => {
  it("retries when saved defaults were applied and the first query failed", () => {
    expect(shouldRetryWithoutTableDataQueryDefaults({ whereInput: "gone = 1" }, errorResult())).toBe(true);
    expect(shouldRetryWithoutTableDataQueryDefaults({ orderBy: "gone" }, errorResult())).toBe(true);
  });

  it("does not retry without saved defaults, on success, or without a result", () => {
    expect(shouldRetryWithoutTableDataQueryDefaults(undefined, errorResult())).toBe(false);
    expect(shouldRetryWithoutTableDataQueryDefaults({ whereInput: "a = 1" }, okResult())).toBe(false);
    expect(shouldRetryWithoutTableDataQueryDefaults({ whereInput: "a = 1" }, undefined)).toBe(false);
    expect(shouldRetryWithoutTableDataQueryDefaults({ whereInput: "a = 1" }, null)).toBe(false);
  });

  it("treats an empty saved-defaults object as nothing applied", () => {
    expect(shouldRetryWithoutTableDataQueryDefaults({}, errorResult())).toBe(false);
  });
});

describe("tableDataQueryDefaults storage round-trip", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and reloads defaults under the scoped key", () => {
    expect(saveTableDataQueryDefaults(scope, { whereInput: "a = 1", orderBy: "b" })).toBe(true);
    expect(loadTableDataQueryDefaults(scope)).toEqual({ whereInput: "a = 1", orderBy: "b" });
  });

  it("isolates scopes by connection/catalog/database/schema/table", () => {
    saveTableDataQueryDefaults(scope, { whereInput: "a = 1" });
    expect(loadTableDataQueryDefaults({ ...scope, database: "db2" })).toBeUndefined();
    expect(loadTableDataQueryDefaults({ ...scope, tableName: "t2" })).toBeUndefined();
  });

  it("remove clears the stored defaults for the scope", () => {
    saveTableDataQueryDefaults(scope, { whereInput: "a = 1" });
    removeTableDataQueryDefaults(scope);
    expect(loadTableDataQueryDefaults(scope)).toBeUndefined();
  });
});
