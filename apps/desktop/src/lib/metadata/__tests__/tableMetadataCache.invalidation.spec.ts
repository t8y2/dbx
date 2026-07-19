import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
}));

import { clearTableMetadataCache, getCachedTableMetadata, invalidateTableMetadataCache, loadTableMetadata } from "@/lib/metadata/tableMetadataCache";

function column(name: string): ColumnInfo {
  return { name, data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null };
}

const request = { connectionId: "c1", database: "db", schema: "public", tableName: "users", databaseType: "postgres" } as const;

describe("tableMetadataCache invalidation", () => {
  beforeEach(() => {
    clearTableMetadataCache();
    vi.clearAllMocks();
    mocks.listIndexes.mockResolvedValue([]);
  });

  it("a stale in-flight load cannot overwrite the cache after invalidation", async () => {
    // 旧加载（结构变更前启动）被挂起
    let releaseOldColumns: (columns: ColumnInfo[]) => void = () => {};
    mocks.getColumns.mockReturnValueOnce(
      new Promise<ColumnInfo[]>((resolve) => {
        releaseOldColumns = resolve;
      }),
    );
    const oldLoad = loadTableMetadata({ ...request });

    // 结构保存：作废缓存并 force 拉新
    invalidateTableMetadataCache({ connectionId: "c1", database: "db", tableName: "users" });
    mocks.getColumns.mockResolvedValueOnce([column("id_new")]);
    const fresh = await loadTableMetadata({ ...request, force: true });
    expect(fresh.metadata.columns[0]?.name).toBe("id_new");

    // 旧加载最后返回：不得回填覆盖新值
    releaseOldColumns([column("id_old")]);
    const oldResult = await oldLoad;
    expect(oldResult.metadata.columns[0]?.name).toBe("id_old");
    expect(getCachedTableMetadata(request)?.metadata.columns[0]?.name).toBe("id_new");
  });

  it("a follower starting after invalidation does not join the stale in-flight load", async () => {
    // 旧加载（失效前启动、non-force、已登记在途）被挂起
    let releaseOldColumns: (columns: ColumnInfo[]) => void = () => {};
    mocks.getColumns.mockReturnValueOnce(
      new Promise<ColumnInfo[]>((resolve) => {
        releaseOldColumns = resolve;
      }),
    );
    const oldLoad = loadTableMetadata({ ...request });

    invalidateTableMetadataCache({ connectionId: "c1", database: "db", tableName: "users" });

    // 失效后的 non-force 跟随者：不得加入旧在途（否则其失效代数取自失效后，
    // 完成时会把旧结果写回缓存），必须自起新加载
    mocks.getColumns.mockResolvedValueOnce([column("id_new")]);
    const follower = await loadTableMetadata({ ...request });
    expect(follower.metadata.columns[0]?.name).toBe("id_new");
    expect(mocks.getColumns).toHaveBeenCalledTimes(2);

    releaseOldColumns([column("id_old")]);
    await oldLoad;
    expect(getCachedTableMetadata(request)?.metadata.columns[0]?.name).toBe("id_new");
  });

  it("invalidating one table does not disturb another table's in-flight load", async () => {
    const requestB = { ...request, tableName: "orders" } as const;
    // A、B 同时挂起
    const releases = new Map<string, (columns: ColumnInfo[]) => void>();
    mocks.getColumns.mockImplementation(
      (_connectionId: string, _database: string, _schema: string, tableName: string) =>
        new Promise<ColumnInfo[]>((resolve) => {
          releases.set(tableName, resolve);
        }),
    );
    const loadA = loadTableMetadata({ ...request });
    const loadB = loadTableMetadata({ ...requestB });
    await Promise.resolve();

    // 仅失效 A
    invalidateTableMetadataCache({ connectionId: "c1", database: "db", tableName: "users" });

    // B 的 follower 必须复用原在途请求：总请求数保持 2（A 一次 + B 一次）。
    // 先让出 microtask，coordinator 的 load 才会真正启动，断言才有观察力
    const followerB = loadTableMetadata({ ...requestB });
    await Promise.resolve();
    expect(mocks.getColumns).toHaveBeenCalledTimes(2);

    // B 返回后正常写入缓存
    releases.get("orders")?.([column("order_id")]);
    expect((await loadB).metadata.columns[0]?.name).toBe("order_id");
    expect((await followerB).metadata.columns[0]?.name).toBe("order_id");
    expect(getCachedTableMetadata(requestB)?.metadata.columns[0]?.name).toBe("order_id");

    // A 跨越失效边界：完成后不得写缓存
    releases.get("users")?.([column("id_old")]);
    await loadA;
    expect(getCachedTableMetadata(request)).toBeUndefined();
  });

  it("caches normally when no invalidation crosses the load", async () => {
    mocks.getColumns.mockResolvedValueOnce([column("id")]);
    await loadTableMetadata({ ...request });
    expect(getCachedTableMetadata(request)?.metadata.columns[0]?.name).toBe("id");
    // 命中缓存：不再发起请求
    await loadTableMetadata({ ...request });
    expect(mocks.getColumns).toHaveBeenCalledTimes(1);
  });
});
