import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTableDisplayDdl: vi.fn(),
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
  persisted: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { cancelObjectDdlLoadsForConnection, getObjectDdlCacheDebugStateForTests, invalidateObjectDdl, invalidateObjectDdlCache, loadObjectDdl, objectDdlCacheKey } from "@/lib/metadata/objectDdlCache";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users", catalog: "analytics" } as const;

describe("objectDdlCache", () => {
  beforeEach(() => {
    clearMetadataRuntimeCache();
    vi.clearAllMocks();
    mocks.persisted.clear();
    mocks.loadSchemaCache.mockImplementation(async (cacheKey: string) => mocks.persisted.get(cacheKey) ?? null);
    mocks.saveSchemaCache.mockImplementation(async (cacheKey: string, payload: unknown) => {
      mocks.persisted.set(cacheKey, payload);
    });
    mocks.deleteSchemaCachePrefix.mockImplementation(async (prefix: string) => {
      for (const cacheKey of mocks.persisted.keys()) {
        if (cacheKey === prefix || cacheKey.startsWith(prefix)) mocks.persisted.delete(cacheKey);
      }
    });
  });

  it("returns persisted DDL without querying the database", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "CREATE TABLE users (id int)" });

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id int)", cacheStatus: "disk" });
    expect(mocks.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("backfills memory after a disk hit", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "CREATE TABLE users (id int)" });

    await expect(loadObjectDdl(request)).resolves.toMatchObject({ cacheStatus: "disk" });
    await expect(loadObjectDdl(request)).resolves.toMatchObject({ cacheStatus: "memory" });
    expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1);
    expect(mocks.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("caches an empty DDL string in memory", async () => {
    mocks.getTableDisplayDdl.mockResolvedValue("");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "", cacheStatus: "remote" });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "", cacheStatus: "memory" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("persists a remote cache miss", async () => {
    mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id bigint)");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ version: 1, ddl: "CREATE TABLE users (id bigint)" }));
  });

  it("does not wait for a slow SQLite write before returning the remote result", async () => {
    let releaseWrite: () => void = () => {};
    mocks.saveSchemaCache.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id bigint)");

    await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(1);
    releaseWrite();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("waits for a pending SQLite write before deleting an invalidated entry", async () => {
    let releaseWrite: () => void = () => {};
    mocks.saveSchemaCache.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("stale ddl");

    await loadObjectDdl(request);
    const invalidation = invalidateObjectDdl(request);
    await Promise.resolve();
    expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalledWith(objectDdlCacheKey(request));

    releaseWrite();
    await invalidation;
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(objectDdlCacheKey(request));
  });

  it("deduplicates concurrent remote loads", async () => {
    let release: (ddl: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const first = loadObjectDdl(request);
    const second = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));

    release("CREATE TABLE users (id int)");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("force refresh bypasses disk and overwrites it", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "old ddl" });
    mocks.getTableDisplayDdl.mockResolvedValue("new ddl");

    await expect(loadObjectDdl(request, { force: true })).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    expect(mocks.loadSchemaCache).not.toHaveBeenCalled();
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ ddl: "new ddl" }));
  });

  it("force refresh bypasses memory and replaces it", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl").mockResolvedValueOnce("new ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "old ddl", cacheStatus: "remote" });
    await expect(loadObjectDdl(request, { force: true })).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "new ddl", cacheStatus: "memory" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("ignores an expired persisted DDL", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), ddl: "stale ddl" });
    mocks.getTableDisplayDdl.mockResolvedValue("fresh ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "fresh ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("deletes the exact persisted entry", async () => {
    await invalidateObjectDdl(request);
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(objectDdlCacheKey(request));
  });

  it("reloads from the database after table-level persisted cache invalidation", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl").mockResolvedValueOnce("new ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "old ddl", cacheStatus: "remote" });
    await invalidateObjectDdlCache({ connectionId: request.connectionId, database: request.database, schema: request.schema, tableName: request.tableName });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("does not persist an in-flight result across invalidation", async () => {
    let release: (ddl: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const load = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));

    await invalidateObjectDdlCache({ connectionId: request.connectionId, database: request.database, schema: request.schema });
    release("stale ddl");
    await expect(load).resolves.toEqual({ ddl: "stale ddl", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
  });

  it("does not resurrect a stale disk result when invalidated during the read", async () => {
    let releaseDiskRead: (value: unknown) => void = () => {};
    mocks.loadSchemaCache.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseDiskRead = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("fresh ddl");

    const load = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
    const invalidation = invalidateObjectDdl(request);
    releaseDiskRead({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale ddl" });

    await expect(load).resolves.toEqual({ ddl: "fresh ddl", cacheStatus: "remote" });
    await invalidation;
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ ddl: "fresh ddl" }));
  });

  it("refreshing object B does not invalidate object A's concurrent disk read", async () => {
    const requestA = { ...request, tableName: "accounts" };
    const requestB = { ...request, tableName: "billing" };
    let releaseA: (value: unknown) => void = () => {};
    let releaseB: (value: unknown) => void = () => {};
    mocks.loadSchemaCache.mockImplementation((cacheKey: string) => {
      return new Promise((resolve) => {
        if (cacheKey === objectDdlCacheKey(requestA)) releaseA = resolve;
        if (cacheKey === objectDdlCacheKey(requestB)) releaseB = resolve;
      });
    });
    mocks.getTableDisplayDdl.mockImplementation(async (_connectionId: string, _database: string, _schema: string, tableName: string) => `remote ${tableName}`);

    const loadA = loadObjectDdl(requestA);
    const loadB = loadObjectDdl(requestB);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(2));
    const invalidation = invalidateObjectDdl(requestB);
    releaseA({ version: 1, cachedAt: new Date().toISOString(), ddl: "cached accounts" });
    releaseB({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale billing" });

    await expect(loadA).resolves.toEqual({ ddl: "cached accounts", cacheStatus: "disk" });
    await expect(loadB).resolves.toEqual({ ddl: "remote billing", cacheStatus: "remote" });
    await invalidation;
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("reclaims invalidation state after long-running multi-object refreshes", async () => {
    for (let index = 0; index < 2_000; index += 1) {
      await invalidateObjectDdlCache({ ...request, tableName: `history_${index}` });
    }

    expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0 });
  });

  it("makes a concurrent normal read wait for a force refresh", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl");
    await loadObjectDdl(request);

    let releaseRemote: (value: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRemote = resolve;
      }),
    );
    const force = loadObjectDdl(request, { force: true });
    const normal = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2));
    releaseRemote("new ddl");

    await expect(Promise.all([force, normal])).resolves.toEqual([
      { ddl: "new ddl", cacheStatus: "remote" },
      { ddl: "new ddl", cacheStatus: "remote" },
    ]);
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("cancels an old connection load without repopulating the new session cache", async () => {
    let releaseOld: (value: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    );
    const oldLoad = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));
    cancelObjectDdlLoadsForConnection(request.connectionId);
    releaseOld("old session ddl");
    await expect(oldLoad).resolves.toMatchObject({ ddl: "old session ddl" });

    mocks.getTableDisplayDdl.mockResolvedValueOnce("new session ddl");
    await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "new session ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalledWith("object-ddl:v1:c1:");
  });
});
