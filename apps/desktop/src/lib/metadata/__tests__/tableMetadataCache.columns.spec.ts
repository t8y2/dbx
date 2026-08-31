import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "@/types/database";

/**
 * Trigger-count regression suite for the columns facet of table metadata.
 *
 * These assert the public contract the display-only (grouped-query comment)
 * loader depends on, so a later refactor of the cache internals keeps the
 * behaviour stable:
 *
 * - columns-only loads issue `getColumns` but never `listIndexes`;
 * - cold vs warm request counts;
 * - in-flight deduplication for concurrent same-table loads;
 * - full<->columns interoperability (no duplicate `getColumns`);
 * - invalidation and per-table isolation.
 */

const mocks = vi.hoisted(() => ({
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
}));

import { clearTableMetadataCache, getCachedTableMetadata, invalidateTableMetadataCache, loadTableColumns, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS } from "@/lib/metadata/tableMetadataCache";

// The coordinator starts its loader on a microtask (Promise.resolve().then), so
// flush before asserting remote call counts.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function column(name: string): ColumnInfo {
  return { name, data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null };
}

const usersRequest = { connectionId: "c1", database: "db", schema: "public", tableName: "users", databaseType: "postgres" } as const;
const ordersRequest = { connectionId: "c1", database: "db", schema: "public", tableName: "orders", databaseType: "postgres" } as const;
const paymentsRequest = { connectionId: "c1", database: "db", schema: "public", tableName: "payments", databaseType: "postgres" } as const;

function callCount(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.length;
}

describe("tableMetadataCache columns facet request counts", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    vi.clearAllMocks();
    mocks.getColumns.mockImplementation(async (_c: string, _d: string, _s: string, table: string) => [column(table)]);
    mocks.listIndexes.mockResolvedValue([]);
  });

  it("R1 — cold single-source columns load: 1 getColumns, 0 listIndexes", async () => {
    const result = await loadTableColumns({ ...usersRequest });
    expect(result.columns[0]?.name).toBe("users");
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(0);
  });

  it("R2 — warm repeat of the same columns load: 0 additional remote calls", async () => {
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(0);
  });

  it("R3 — cold multi-source columns loads: N getColumns, 0 listIndexes", async () => {
    await Promise.all([loadTableColumns({ ...usersRequest }), loadTableColumns({ ...ordersRequest }), loadTableColumns({ ...paymentsRequest })]);
    expect(callCount(mocks.getColumns)).toBe(3);
    expect(callCount(mocks.listIndexes)).toBe(0);
  });

  it("R5 — concurrent same-source columns loads dedupe to one getColumns", async () => {
    let releaseFirst: (value: ColumnInfo[]) => void = () => {};
    mocks.getColumns.mockReturnValueOnce(
      new Promise<ColumnInfo[]>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const first = loadTableColumns({ ...usersRequest });
    const second = loadTableColumns({ ...usersRequest });
    await flush();
    // The second call must join the first's in-flight load, not start another.
    expect(callCount(mocks.getColumns)).toBe(1);
    releaseFirst([column("id")]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.columns[0]?.name).toBe("id");
    expect(b.columns[0]?.name).toBe("id");
    expect(callCount(mocks.getColumns)).toBe(1);
  });

  it("R5b — concurrent full metadata and columns-only loads share the columns call", async () => {
    // loadTableMetadata starts its columns facet synchronously, so a concurrent
    // display-only columns load dedupes against it: exactly one getColumns.
    let releaseColumns: (value: ColumnInfo[]) => void = () => {};
    mocks.getColumns.mockReturnValueOnce(
      new Promise<ColumnInfo[]>((resolve) => {
        releaseColumns = resolve;
      }),
    );
    const full = loadTableMetadata({ ...usersRequest });
    const colsOnly = loadTableColumns({ ...usersRequest });
    await flush();
    expect(callCount(mocks.getColumns)).toBe(1);
    releaseColumns([column("id")]);
    const [fullResult, colsResult] = await Promise.all([full, colsOnly]);
    expect(fullResult.metadata.columns[0]?.name).toBe("id");
    expect(colsResult.columns[0]?.name).toBe("id");
    expect(callCount(mocks.getColumns)).toBe(1);
    // listIndexes is only needed by the full load, and only once.
    expect(callCount(mocks.listIndexes)).toBe(1);
  });

  it("R6 — full metadata first, then columns-only: 0 additional getColumns / 0 listIndexes", async () => {
    await loadTableMetadata({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(1);
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(1);
  });

  it("R7 — columns-only first, then full metadata: 0 additional getColumns, 1 listIndexes", async () => {
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(0);
    await loadTableMetadata({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    expect(callCount(mocks.listIndexes)).toBe(1);
  });

  it("R7b — promoting near-expiry columns does not reset the full metadata TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
      await loadTableColumns({ ...usersRequest });
      vi.advanceTimersByTime(TABLE_METADATA_CACHE_TTL_MS - 100);

      await loadTableMetadata({ ...usersRequest });
      expect(callCount(mocks.getColumns)).toBe(1);
      expect(callCount(mocks.listIndexes)).toBe(1);

      vi.advanceTimersByTime(200);
      expect(getCachedTableMetadata({ ...usersRequest })).toBeUndefined();

      await loadTableMetadata({ ...usersRequest });
      expect(callCount(mocks.getColumns)).toBe(2);
      expect(callCount(mocks.listIndexes)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("R8 — invalidating a table forces the next columns load to re-query", async () => {
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    invalidateTableMetadataCache({ connectionId: "c1", database: "db", tableName: "users" });
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(2);
    expect(callCount(mocks.listIndexes)).toBe(0);
  });

  it("R9 — caching one table does not satisfy a different table", async () => {
    await loadTableColumns({ ...usersRequest });
    expect(callCount(mocks.getColumns)).toBe(1);
    await loadTableColumns({ ...ordersRequest });
    expect(callCount(mocks.getColumns)).toBe(2);
    expect(callCount(mocks.listIndexes)).toBe(0);
  });

  it("R10 — a failing columns-only load rejects and never triggers listIndexes", async () => {
    mocks.getColumns.mockRejectedValue(new Error("metadata unavailable"));
    await expect(loadTableColumns({ ...usersRequest })).rejects.toThrow("metadata unavailable");
    expect(callCount(mocks.listIndexes)).toBe(0);
    // A subsequent load is not poisoned by the failed attempt.
    mocks.getColumns.mockResolvedValueOnce([column("id")]);
    const retry = await loadTableColumns({ ...usersRequest });
    expect(retry.columns[0]?.name).toBe("id");
  });
});
