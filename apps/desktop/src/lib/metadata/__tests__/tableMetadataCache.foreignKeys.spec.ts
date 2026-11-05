import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForeignKeyInfo } from "@/types/database";

/**
 * Regression suite for the foreign-key facet of table metadata.
 *
 * The facet exists so the structure panel and the grid's foreign-key navigation
 * share one remote `listForeignKeys` per table instead of each issuing its own
 * request (which, over an agent connection, used to mean a fresh handshake per
 * read). These assertions pin that contract:
 *
 * - one remote read per table per TTL window;
 * - in-flight deduplication for concurrent same-table loads;
 * - per-table isolation and `force` bypass;
 * - invalidation (refresh) makes the next read see fresh foreign keys;
 * - a load started before invalidation must not write back afterwards.
 */

const mocks = vi.hoisted(() => ({
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  listForeignKeys: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  listForeignKeys: mocks.listForeignKeys,
}));

import { clearTableMetadataCache, getCachedTableForeignKeys, invalidateTableMetadataCache, loadTableForeignKeys } from "@/lib/metadata/tableMetadataCache";

// The coordinator starts its loader on a microtask (Promise.resolve().then), so
// flush before asserting remote call counts.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function foreignKey(name: string): ForeignKeyInfo {
  return { name, column: "user_id", ref_table: "users", ref_column: "id" };
}

const usersRequest = { connectionId: "c1", database: "db", schema: "public", tableName: "users", databaseType: "postgres" } as const;
const ordersRequest = { connectionId: "c1", database: "db", schema: "public", tableName: "orders", databaseType: "postgres" } as const;

describe("tableMetadataCache foreign-key facet", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    vi.clearAllMocks();
    mocks.listForeignKeys.mockImplementation(async (_c: string, _d: string, _s: string, table: string) => [foreignKey(`${table}_fk`)]);
  });

  it("issues one remote read per table and serves the next call from cache", async () => {
    const first = await loadTableForeignKeys(usersRequest);
    const second = await loadTableForeignKeys(usersRequest);

    expect(first).toEqual(second);
    expect(mocks.listForeignKeys).toHaveBeenCalledOnce();
    expect(getCachedTableForeignKeys(usersRequest)?.foreignKeys).toEqual(first);
  });

  it("deduplicates concurrent loads for the same table", async () => {
    const [a, b] = await Promise.all([loadTableForeignKeys(usersRequest), loadTableForeignKeys(usersRequest)]);

    expect(a).toEqual(b);
    expect(mocks.listForeignKeys).toHaveBeenCalledOnce();
  });

  it("keeps tables isolated and lets force bypass the cache", async () => {
    await loadTableForeignKeys(usersRequest);
    await loadTableForeignKeys(ordersRequest);
    expect(mocks.listForeignKeys).toHaveBeenCalledTimes(2);

    await loadTableForeignKeys({ ...usersRequest, force: true });
    expect(mocks.listForeignKeys).toHaveBeenCalledTimes(3);
  });

  it("refetches after invalidation so a refresh surfaces foreign keys changed elsewhere", async () => {
    await loadTableForeignKeys(usersRequest);
    mocks.listForeignKeys.mockResolvedValueOnce([foreignKey("fresh_fk")]);

    invalidateTableMetadataCache({ connectionId: "c1" });
    const refreshed = await loadTableForeignKeys(usersRequest);

    expect(refreshed).toEqual([foreignKey("fresh_fk")]);
    expect(mocks.listForeignKeys).toHaveBeenCalledTimes(2);
  });

  it("does not let a load started before invalidation write back afterwards", async () => {
    let finish!: (keys: ForeignKeyInfo[]) => void;
    mocks.listForeignKeys.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const stale = loadTableForeignKeys(usersRequest);
    await flush();
    invalidateTableMetadataCache({ connectionId: "c1" });
    mocks.listForeignKeys.mockResolvedValueOnce([foreignKey("fresh_fk")]);
    const fresh = loadTableForeignKeys(usersRequest);
    finish([foreignKey("stale_fk")]);
    await stale;
    await fresh;

    expect(getCachedTableForeignKeys(usersRequest)?.foreignKeys).toEqual([foreignKey("fresh_fk")]);
  });
});
