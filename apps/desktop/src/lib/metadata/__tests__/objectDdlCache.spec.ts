import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTableDisplayDdl: vi.fn(),
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { invalidateObjectDdl, invalidateObjectDdlCache, loadObjectDdl, objectDdlCacheKey } from "@/lib/metadata/objectDdlCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users" } as const;

describe("objectDdlCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSchemaCache.mockResolvedValue(null);
    mocks.saveSchemaCache.mockResolvedValue(undefined);
    mocks.deleteSchemaCachePrefix.mockResolvedValue(undefined);
  });

  it("returns persisted DDL without querying the database", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "CREATE TABLE users (id int)" });

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id int)", cacheStatus: "disk" });
    expect(mocks.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("persists a remote cache miss", async () => {
    mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id bigint)");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ version: 1, ddl: "CREATE TABLE users (id bigint)" }));
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

  it("deletes the exact persisted entry", async () => {
    await invalidateObjectDdl(request);
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(objectDdlCacheKey(request));
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
});
