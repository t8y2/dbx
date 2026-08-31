import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
  persisted: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { cancelObjectMetadataLoadsForConnection, getObjectMetadataCacheDebugStateForTests, invalidateObjectMetadataCache, loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users", catalog: "analytics" } as const;

describe("objectMetadataCache", () => {
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

  it("reads a facet from disk without invoking the loader", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), value: [{ name: "id" }] });
    const loader = vi.fn().mockResolvedValue([{ name: "remote" }]);

    await expect(loadObjectMetadataFacet(request, "columns", loader)).resolves.toEqual({ value: [{ name: "id" }], cacheStatus: "disk" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("backfills memory after a disk hit", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), value: [] });
    const loader = vi.fn();

    await expect(loadObjectMetadataFacet(request, "columns", loader)).resolves.toEqual({ value: [], cacheStatus: "disk" });
    await expect(loadObjectMetadataFacet(request, "columns", loader)).resolves.toEqual({ value: [], cacheStatus: "memory" });
    expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it("caches null and empty-array facet values", async () => {
    const nullLoader = vi.fn().mockResolvedValue(null);
    const emptyLoader = vi.fn().mockResolvedValue([]);

    await expect(loadObjectMetadataFacet(request, "comment", nullLoader)).resolves.toMatchObject({ value: null, cacheStatus: "remote" });
    await expect(loadObjectMetadataFacet(request, "comment", nullLoader)).resolves.toMatchObject({ value: null, cacheStatus: "memory" });
    await expect(loadObjectMetadataFacet(request, "indexes", emptyLoader)).resolves.toMatchObject({ value: [], cacheStatus: "remote" });
    await expect(loadObjectMetadataFacet(request, "indexes", emptyLoader)).resolves.toMatchObject({ value: [], cacheStatus: "memory" });
    expect(nullLoader).toHaveBeenCalledTimes(1);
    expect(emptyLoader).toHaveBeenCalledTimes(1);
  });

  it("does not cache undefined failure sentinels", async () => {
    const loader = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("fresh comment");

    await expect(loadObjectMetadataFacet(request, "comment", loader)).resolves.toMatchObject({ value: undefined, cacheStatus: "remote" });
    await expect(loadObjectMetadataFacet(request, "comment", loader)).resolves.toMatchObject({ value: "fresh comment", cacheStatus: "remote" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("isolates facets by object type", async () => {
    const tableLoader = vi.fn().mockResolvedValue(["table"]);
    const viewLoader = vi.fn().mockResolvedValue(["view"]);

    await loadObjectMetadataFacet({ ...request, objectType: "TABLE" }, "columns", tableLoader);
    await loadObjectMetadataFacet({ ...request, objectType: "VIEW" }, "columns", viewLoader);
    expect(tableLoader).toHaveBeenCalledTimes(1);
    expect(viewLoader).toHaveBeenCalledTimes(1);
  });

  it("persists a remote facet and force bypasses disk", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), value: ["old"] });
    const loader = vi.fn().mockResolvedValue(["new"]);

    await expect(loadObjectMetadataFacet(request, "indexes", loader, { force: true })).resolves.toEqual({ value: ["new"], cacheStatus: "remote" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mocks.loadSchemaCache).not.toHaveBeenCalled();
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(expect.stringContaining("object-meta:v1:c1:app:public:users:analytics:TABLE:indexes:"), expect.objectContaining({ value: ["new"] }));
  });

  it("does not wait for a slow SQLite write before returning a remote facet", async () => {
    let releaseWrite: () => void = () => {};
    mocks.saveSchemaCache.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    const loader = vi.fn().mockResolvedValue(["id"]);

    await expect(loadObjectMetadataFacet(request, "columns", loader)).resolves.toMatchObject({ value: ["id"], cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(1);
    releaseWrite();
  });

  it("deduplicates concurrent remote facet loads", async () => {
    let release: (value: string[]) => void = () => {};
    const loader = vi.fn().mockReturnValue(
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = loadObjectMetadataFacet(request, "columns", loader);
    const second = loadObjectMetadataFacet(request, "columns", loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    release(["id"]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: ["id"], cacheStatus: "remote" },
      { value: ["id"], cacheStatus: "remote" },
    ]);
  });

  it("force refresh bypasses memory and replaces it", async () => {
    const loader = vi.fn().mockResolvedValueOnce(["old"]).mockResolvedValueOnce(["new"]);

    await expect(loadObjectMetadataFacet(request, "indexes", loader)).resolves.toMatchObject({ value: ["old"], cacheStatus: "remote" });
    await expect(loadObjectMetadataFacet(request, "indexes", loader, { force: true })).resolves.toMatchObject({ value: ["new"], cacheStatus: "remote" });
    await expect(loadObjectMetadataFacet(request, "indexes", loader)).resolves.toMatchObject({ value: ["new"], cacheStatus: "memory" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("ignores an expired persisted facet", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), value: ["stale"] });
    const loader = vi.fn().mockResolvedValue(["fresh"]);

    await expect(loadObjectMetadataFacet(request, "indexes", loader)).resolves.toMatchObject({ value: ["fresh"], cacheStatus: "remote" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates only the requested object's facets", async () => {
    await invalidateObjectMetadataCache(request);
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith("object-meta:v1:c1:app:public:users:");
  });

  it("reloads a persisted facet after table-level invalidation", async () => {
    const initialLoader = vi.fn().mockResolvedValue(["old"]);
    const refreshedLoader = vi.fn().mockResolvedValue(["new"]);

    await expect(loadObjectMetadataFacet(request, "indexes", initialLoader)).resolves.toEqual({ value: ["old"], cacheStatus: "remote" });
    await invalidateObjectMetadataCache({ connectionId: request.connectionId, database: request.database, schema: request.schema, tableName: request.tableName });
    await expect(loadObjectMetadataFacet(request, "indexes", refreshedLoader)).resolves.toEqual({ value: ["new"], cacheStatus: "remote" });
    expect(refreshedLoader).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a stale disk facet when invalidated during the read", async () => {
    let releaseDiskRead: (value: unknown) => void = () => {};
    mocks.loadSchemaCache.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseDiskRead = resolve;
      }),
    );
    const loader = vi.fn().mockResolvedValue(["fresh"]);

    const load = loadObjectMetadataFacet(request, "columns", loader);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
    const invalidation = invalidateObjectMetadataCache(request);
    releaseDiskRead({ version: 1, cachedAt: new Date().toISOString(), value: ["stale"] });

    await expect(load).resolves.toEqual({ value: ["fresh"], cacheStatus: "remote" });
    await invalidation;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(expect.stringContaining("object-meta:v1:c1:app:public:users:"), expect.objectContaining({ value: ["fresh"] }));
  });

  it("refreshing object B does not invalidate object A's concurrent facet read", async () => {
    const requestA = { ...request, tableName: "accounts" };
    const requestB = { ...request, tableName: "billing" };
    let releaseA: (value: unknown) => void = () => {};
    let releaseB: (value: unknown) => void = () => {};
    let diskReads = 0;
    mocks.loadSchemaCache.mockImplementation((cacheKey: string) => {
      diskReads += 1;
      if (diskReads > 2) return Promise.resolve(null);
      return new Promise((resolve) => {
        if (cacheKey.includes(":accounts:")) releaseA = resolve;
        if (cacheKey.includes(":billing:")) releaseB = resolve;
      });
    });
    const loaderA = vi.fn().mockResolvedValue(["remote accounts"]);
    const loaderB = vi.fn().mockResolvedValue(["remote billing"]);

    const loadA = loadObjectMetadataFacet(requestA, "columns", loaderA);
    const loadB = loadObjectMetadataFacet(requestB, "columns", loaderB);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(2));
    const invalidation = invalidateObjectMetadataCache(requestB);
    releaseA({ version: 1, cachedAt: new Date().toISOString(), value: ["cached accounts"] });
    releaseB({ version: 1, cachedAt: new Date().toISOString(), value: ["stale billing"] });

    await expect(loadA).resolves.toEqual({ value: ["cached accounts"], cacheStatus: "disk" });
    await expect(loadB).resolves.toEqual({ value: ["remote billing"], cacheStatus: "remote" });
    await invalidation;
    expect(loaderA).not.toHaveBeenCalled();
    expect(loaderB).toHaveBeenCalledTimes(1);
  });

  it("reclaims invalidation state after long-running multi-object refreshes", async () => {
    for (let index = 0; index < 2_000; index += 1) {
      await invalidateObjectMetadataCache({ ...request, tableName: `history_${index}` });
    }

    expect(getObjectMetadataCacheDebugStateForTests()).toEqual({ activeReads: 0 });
  });

  it("makes a concurrent normal facet read wait for a force refresh", async () => {
    const loader = vi.fn().mockResolvedValueOnce(["old"]);
    await loadObjectMetadataFacet(request, "indexes", loader);

    let releaseRemote: (value: string[]) => void = () => {};
    loader.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRemote = resolve;
      }),
    );
    const force = loadObjectMetadataFacet(request, "indexes", loader, { force: true });
    const normal = loadObjectMetadataFacet(request, "indexes", loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    releaseRemote(["new"]);

    await expect(Promise.all([force, normal])).resolves.toEqual([
      { value: ["new"], cacheStatus: "remote" },
      { value: ["new"], cacheStatus: "remote" },
    ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("cancels an old connection facet load without repopulating the new session cache", async () => {
    let releaseOld: (value: string[]) => void = () => {};
    const loader = vi.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    );
    const oldLoad = loadObjectMetadataFacet(request, "columns", loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    cancelObjectMetadataLoadsForConnection(request.connectionId);
    releaseOld(["old session"]);
    await expect(oldLoad).resolves.toMatchObject({ value: ["old session"] });

    loader.mockResolvedValueOnce(["new session"]);
    await expect(loadObjectMetadataFacet(request, "columns", loader)).resolves.toMatchObject({ value: ["new session"], cacheStatus: "remote" });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalledWith("object-meta:v1:c1:");
  });
});
