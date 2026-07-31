import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { invalidateObjectMetadataCache, loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users" } as const;

describe("objectMetadataCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSchemaCache.mockResolvedValue(null);
    mocks.saveSchemaCache.mockResolvedValue(undefined);
    mocks.deleteSchemaCachePrefix.mockResolvedValue(undefined);
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
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(expect.stringContaining("object-meta:v1:c1:app:public::users:indexes:"), expect.objectContaining({ value: ["new"] }));
  });

  it("invalidates only the requested object's facets", async () => {
    await invalidateObjectMetadataCache(request);
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith("object-meta:v1:c1:app:public:users:");
  });
});
