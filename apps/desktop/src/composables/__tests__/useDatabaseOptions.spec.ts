import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseOptionsForConnection, fetchNamespaceOptionsForConnection, fetchSqlFileTargetOptions, namespaceOptionsAreSchemas, useDatabaseOptions } from "@/composables/useDatabaseOptions";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
  }),
}));

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
