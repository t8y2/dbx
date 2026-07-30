import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  databaseAfterCatalogChange,
  databaseOptionsForConnection,
  fetchNamespaceOptionsForConnection,
  fetchSqlFileTargetOptions,
  namespaceOptionsAreSchemas,
  normalizedQueryTabCatalog,
  queryCatalogSelectorVisible,
  selectedQueryCatalogName,
  useDatabaseOptions,
} from "@/composables/useDatabaseOptions";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
  listDorisCatalogs: vi.fn(),
  listDorisCatalogDatabases: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listDorisCatalogs: mocks.listDorisCatalogs,
  listDorisCatalogDatabases: mocks.listDorisCatalogDatabases,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
  }),
}));

const internalCatalog = { name: "default_catalog", catalog_type: "internal", is_current: true };
const paimonCatalog = { name: "paimon_catalog", catalog_type: "paimon", is_current: false };

describe("query catalog options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the selector only when an external catalog exists", () => {
    expect(queryCatalogSelectorVisible([internalCatalog])).toBe(false);
    expect(queryCatalogSelectorVisible([internalCatalog, paimonCatalog])).toBe(true);
  });

  it("maps the internal catalog to an undefined tab catalog", () => {
    const catalogs = [internalCatalog, paimonCatalog];

    expect(selectedQueryCatalogName(catalogs)).toBe("default_catalog");
    expect(normalizedQueryTabCatalog(catalogs, "default_catalog")).toBeUndefined();
    expect(normalizedQueryTabCatalog(catalogs, "paimon_catalog")).toBe("paimon_catalog");
  });

  it("keeps a database only when it exists in the selected catalog", () => {
    expect(databaseAfterCatalogChange("bi", ["bi", "default"])).toBe("bi");
    expect(databaseAfterCatalogChange("bi", ["analytics"])).toBe("");
  });

  it("loads and caches catalog-scoped databases", async () => {
    mocks.getConfig.mockReturnValue({ db_type: "starrocks" });
    mocks.listDorisCatalogs.mockResolvedValue([internalCatalog, paimonCatalog]);
    mocks.listDorisCatalogDatabases.mockResolvedValue([{ name: "bi" }, { name: "analytics" }]);
    const options = useDatabaseOptions();

    await expect(options.loadCatalogOptions("connection-1")).resolves.toEqual([internalCatalog, paimonCatalog]);
    await expect(options.loadCatalogDatabaseOptions("connection-1", "paimon_catalog")).resolves.toEqual(["bi", "analytics"]);
    await options.loadCatalogDatabaseOptions("connection-1", "paimon_catalog");

    expect(options.catalogDatabaseOptions.value["connection-1:paimon_catalog"]).toEqual(["bi", "analytics"]);
    expect(mocks.listDorisCatalogDatabases).toHaveBeenCalledTimes(1);
  });
});

describe("namespace options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Dameng schemas so independent schemas remain selectable", async () => {
    mocks.listSchemas.mockResolvedValue(["APP_USER", "REPORTING", "SYS"]);

    const options = await fetchNamespaceOptionsForConnection("connection-1", {
      db_type: "dameng",
      database: "APP_USER",
      visible_databases: ["APP_USER", "REPORTING"],
    });

    expect(options).toEqual(["APP_USER", "REPORTING"]);
    expect(mocks.listSchemas).toHaveBeenCalledWith("connection-1", "APP_USER", true);
    expect(mocks.listDatabases).not.toHaveBeenCalled();
  });

  it("honors the configured Dameng schema filter before the legacy database filter", async () => {
    mocks.listSchemas.mockResolvedValue(["APP_USER", "REPORTING", "ARCHIVE"]);

    const options = await fetchNamespaceOptionsForConnection("connection-1", {
      db_type: "dameng",
      database: "APP_USER",
      visible_databases: ["APP_USER", "REPORTING"],
      visible_schemas: { APP_USER: ["ARCHIVE"] },
    });

    expect(options).toEqual(["ARCHIVE"]);
  });

  it("preserves listDatabases and visible database filtering for other databases", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "analytics" }, { name: "postgres" }]);

    const options = await fetchNamespaceOptionsForConnection("connection-2", {
      db_type: "postgres",
      database: "app",
      visible_databases: ["analytics"],
    });

    expect(options).toEqual(["analytics"]);
    expect(mocks.listDatabases).toHaveBeenCalledWith("connection-2");
    expect(mocks.listSchemas).not.toHaveBeenCalled();
  });

  it("preserves visible database filtering for MongoDB transfer options", () => {
    expect(
      databaseOptionsForConnection(["app", "analytics", "admin"], {
        db_type: "mongodb",
        visible_databases: ["analytics"],
      }),
    ).toEqual(["analytics"]);
  });

  it("propagates metadata loading errors", async () => {
    const error = new Error("schema metadata failed");
    mocks.listSchemas.mockRejectedValue(error);

    await expect(
      fetchNamespaceOptionsForConnection("connection-1", {
        db_type: "dameng",
        database: "APP_USER",
      }),
    ).rejects.toBe(error);
  });

  it("keeps the SQL file target on the shared namespace loader", async () => {
    mocks.listSchemas.mockResolvedValue(["APP_USER", "REPORTING"]);

    await expect(
      fetchSqlFileTargetOptions("connection-1", {
        db_type: "dameng",
        database: "APP_USER",
      }),
    ).resolves.toEqual(["APP_USER", "REPORTING"]);
  });

  it("identifies only Dameng top-level options as schemas", () => {
    expect(namespaceOptionsAreSchemas({ db_type: "dameng" })).toBe(true);
    expect(namespaceOptionsAreSchemas({ db_type: "oracle" })).toBe(false);
    expect(namespaceOptionsAreSchemas({ db_type: "postgres" })).toBe(false);
  });

  it("does not expand the global database options composable to Dameng schemas", async () => {
    mocks.getConfig.mockReturnValue({ db_type: "dameng" });
    mocks.listDatabases.mockResolvedValue([]);

    const { databaseOptions, loadDatabaseOptions } = useDatabaseOptions();
    await loadDatabaseOptions("connection-1");

    expect(databaseOptions.value["connection-1"]).toEqual([]);
    expect(mocks.listDatabases).toHaveBeenCalledWith("connection-1");
    expect(mocks.listSchemas).not.toHaveBeenCalled();
  });
});
