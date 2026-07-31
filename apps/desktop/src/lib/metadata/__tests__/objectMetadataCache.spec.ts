import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
  persisted: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { invalidateObjectMetadataCache, loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users", catalog: "analytics" } as const;

describe("objectMetadataCache", () => {
  beforeEach(() => {
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

  it("persists a remote facet and force bypasses disk", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), value: ["old"] });
    const loader = vi.fn().mockResolvedValue(["new"]);

    await expect(loadObjectMetadataFacet(request, "indexes", loader, { force: true })).resolves.toEqual({ value: ["new"], cacheStatus: "remote" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mocks.loadSchemaCache).not.toHaveBeenCalled();
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(expect.stringContaining("object-meta:v1:c1:app:public:users:analytics:indexes:"), expect.objectContaining({ value: ["new"] }));
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
});
