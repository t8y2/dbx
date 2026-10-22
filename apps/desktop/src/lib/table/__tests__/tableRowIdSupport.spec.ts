import { beforeEach, describe, expect, it } from "vitest";
import { markRowIdLocatorSupported, markRowIdLocatorUnsupported, resetRowIdLocatorStateForTests, rowIdLocatorUnsupported, shouldKeepRowIdLocatorDisabled, shouldRetryWithoutRowIdLocator } from "@/lib/table/tableRowIdSupport";
import type { QueryResult } from "@/types/database";

const locatorSql = `SELECT tableoid::text || ':' || ctid::text || ':' || xmin::text AS "__DBX_ROWID", * FROM "public"."events" LIMIT 200;`;
const plainSql = `SELECT * FROM "public"."events" LIMIT 200;`;

function resultOf(executionError: boolean): QueryResult {
  return { columns: ["id"], rows: executionError ? [["db error"]] : [[1]], affected_rows: 0, execution_time_ms: 1, execution_error: executionError } as unknown as QueryResult;
}

describe("tableRowIdSupport", () => {
  beforeEach(() => {
    resetRowIdLocatorStateForTests();
  });

  it("retries once for a failed load whose SQL carried the locator", () => {
    expect(shouldRetryWithoutRowIdLocator(locatorSql, resultOf(true))).toBe(true);
  });

  it("does not retry successful loads, plain SQL, or missing results", () => {
    expect(shouldRetryWithoutRowIdLocator(locatorSql, resultOf(false))).toBe(false);
    expect(shouldRetryWithoutRowIdLocator(plainSql, resultOf(true))).toBe(false);
    expect(shouldRetryWithoutRowIdLocator(locatorSql, undefined)).toBe(false);
  });

  it("still retries an already-issued locator query after another request disables the connection", () => {
    markRowIdLocatorUnsupported("conn-1");
    expect(shouldRetryWithoutRowIdLocator(locatorSql, resultOf(true))).toBe(true);
  });

  it("keeps the flag only after a successful fallback and restores it on a failed one", () => {
    markRowIdLocatorUnsupported("conn-1");
    expect(shouldKeepRowIdLocatorDisabled(resultOf(false))).toBe(true);
    expect(shouldKeepRowIdLocatorDisabled(resultOf(true))).toBe(false);
    expect(shouldKeepRowIdLocatorDisabled(undefined)).toBe(false);

    markRowIdLocatorSupported("conn-1");
    expect(rowIdLocatorUnsupported("conn-1")).toBe(false);
  });

  it("tracks unsupported connections independently", () => {
    markRowIdLocatorUnsupported("conn-1");
    expect(rowIdLocatorUnsupported("conn-1")).toBe(true);
    expect(rowIdLocatorUnsupported("conn-2")).toBe(false);
  });
});
