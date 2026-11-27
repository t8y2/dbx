import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "@/types/database";

/**
 * PostgreSQL access-method probe (#15865): keyless base tables carry their
 * `pg_am.amname` in table metadata so the grid can skip the ctid tuple
 * locator on column-store storage (PolarDB CSI `polar_duckdb`). Keyed
 * tables never receive the locator, so they must not pay the probe.
 */

const mocks = vi.hoisted(() => ({
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  executeQuery: mocks.executeQuery,
}));

import { clearTableMetadataCache, loadTableMetadata, postgresAccessMethodFromResult, postgresAccessMethodProbeSql } from "@/lib/metadata/tableMetadataCache";

function column(name: string, primaryKey = false): ColumnInfo {
  return { name, data_type: "text", is_nullable: true, is_primary_key: primaryKey } as ColumnInfo;
}

const keylessRequest = { connectionId: "pg-1", database: "app", schema: "chat", tableName: "room_messages", tableType: "BASE TABLE", databaseType: "postgres" };

describe("postgres access-method probe", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    mocks.getColumns.mockReset();
    mocks.listIndexes.mockReset();
    mocks.executeQuery.mockReset();
    mocks.listIndexes.mockResolvedValue([]);
  });

  it("attaches the probed access method for keyless postgres tables", async () => {
    mocks.getColumns.mockResolvedValue([column("payload")]);
    mocks.executeQuery.mockResolvedValue({ columns: ["amname"], rows: [["polar_duckdb"]], execution_error: false });

    const { metadata } = await loadTableMetadata(keylessRequest);

    expect(metadata.accessMethod).toBe("polar_duckdb");
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
    expect(String(mocks.executeQuery.mock.calls[0]?.[2])).toContain("pg_am");
  });

  it("does not probe keyed tables", async () => {
    mocks.getColumns.mockResolvedValue([column("id", true)]);

    const { metadata } = await loadTableMetadata(keylessRequest);

    expect(metadata.accessMethod).toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });

  it("keeps metadata usable when the probe fails", async () => {
    mocks.getColumns.mockResolvedValue([column("payload")]);
    mocks.executeQuery.mockRejectedValue(new Error("permission denied"));

    const { metadata } = await loadTableMetadata(keylessRequest);

    expect(metadata.columns).toHaveLength(1);
    expect(metadata.accessMethod).toBeUndefined();
  });

  it("builds a schema-scoped probe and escapes literals", () => {
    expect(postgresAccessMethodProbeSql("chat", "room_messages")).toContain("n.nspname = 'chat'");
    expect(postgresAccessMethodProbeSql(undefined, "o'brien")).toContain("current_schema()");
    expect(postgresAccessMethodProbeSql(undefined, "o'brien")).toContain("'o''brien'");
  });

  it("parses only successful non-empty probe results", () => {
    expect(postgresAccessMethodFromResult({ rows: [["heap"]] })).toBe("heap");
    expect(postgresAccessMethodFromResult({ rows: [[""]] })).toBeUndefined();
    expect(postgresAccessMethodFromResult({ rows: [["heap"]], execution_error: true })).toBeUndefined();
    expect(postgresAccessMethodFromResult(undefined)).toBeUndefined();
  });
});
