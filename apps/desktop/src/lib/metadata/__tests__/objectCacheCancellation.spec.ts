import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ loadSchemaCache: vi.fn(), saveSchemaCache: vi.fn(), deleteSchemaCachePrefix: vi.fn(), getTableDisplayDdl: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
import { cancelObjectDdlLoadsForDatabase, loadObjectDdl } from "../objectDdlCache";
import { cancelObjectMetadataLoadsForDatabase, loadObjectMetadataFacet } from "../objectMetadataCache";
import { clearMetadataRuntimeCache } from "../metadataRuntimeCache";

const request = { connectionId: "cancel-boundary", database: "app", schema: "TEST", tableName: "OBJECT" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.each(["ddl", "facet"] as const)("%s cache cancellation boundary", (kind) => {
  const load = (force = false) => (kind === "ddl" ? loadObjectDdl(request, { force }) : loadObjectMetadataFacet(request, "columns", api.getTableDisplayDdl, { force }));
  const cancel = (database = request.database) => (kind === "ddl" ? cancelObjectDdlLoadsForDatabase(request.connectionId, database) : cancelObjectMetadataLoadsForDatabase(request.connectionId, database));
  beforeEach(() => {
    vi.resetAllMocks();
    clearMetadataRuntimeCache();
    api.loadSchemaCache.mockResolvedValue(null);
    api.saveSchemaCache.mockResolvedValue(undefined);
    api.deleteSchemaCachePrefix.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([120, 0])("honors a configured query timeout of %s beyond the default cache budget", async (queryTimeoutSecs) => {
    vi.useFakeTimers();
    const remote = deferred<string>();
    api.getTableDisplayDdl.mockReturnValueOnce(remote.promise);
    const configuredRequest = { ...request, queryTimeoutSecs };
    const result = kind === "ddl" ? loadObjectDdl(configuredRequest) : loadObjectMetadataFacet(configuredRequest, "columns", api.getTableDisplayDdl);
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    remote.resolve("configured result");
    expect(await outcome).toMatchObject({ value: { cacheStatus: "remote" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled remote read, releases its cache slot, and ignores its late success", async () => {
    vi.useFakeTimers();
    const old = deferred<string>();
    api.getTableDisplayDdl.mockReturnValueOnce(old.promise).mockResolvedValueOnce("fresh");
    const result = load();
    const rejected = expect(result).rejects.toThrow("Metadata loading timed out");
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    old.resolve("stale");
    await Promise.resolve();
    expect(api.saveSchemaCache).not.toHaveBeenCalled();
    await expect(load()).resolves.toMatchObject({ cacheStatus: "remote" });
    expect(api.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("cancels a forced load waiting for disk deletion without starting a late database read", async () => {
    const deletion = deferred<void>();
    api.deleteSchemaCachePrefix.mockReturnValueOnce(deletion.promise);
    const result = load(true);
    const rejected = expect(result).rejects.toThrow("Metadata waiting cancelled locally.");
    await vi.waitFor(() => expect(api.deleteSchemaCachePrefix).toHaveBeenCalledTimes(1));
    cancel();
    await rejected;
    deletion.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("keeps another database request alive and rejects the cancelled disk read before it can cache late data", async () => {
    const disk = deferred<unknown>();
    api.loadSchemaCache.mockReturnValueOnce(disk.promise);
    const result = load();
    const rejected = expect(result).rejects.toThrow("Metadata waiting cancelled locally.");
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(api.loadSchemaCache).toHaveBeenCalledTimes(1));
    cancel("unrelated");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel();
    await rejected;
    disk.resolve({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale", value: "stale" });
    await Promise.resolve();
    api.getTableDisplayDdl.mockResolvedValueOnce("fresh");
    await expect(load()).resolves.toMatchObject({ cacheStatus: "remote" });
    expect(api.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });
});
