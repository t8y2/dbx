import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSqlFileTargetOptions } from "@/composables/useDatabaseOptions";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

describe("fetchSqlFileTargetOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Dameng schemas so independent schemas remain selectable", async () => {
    mocks.listSchemas.mockResolvedValue(["APP_USER", "REPORTING", "SYS"]);

    const options = await fetchSqlFileTargetOptions("connection-1", {
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

    const options = await fetchSqlFileTargetOptions("connection-1", {
      db_type: "dameng",
      database: "APP_USER",
      visible_databases: ["APP_USER", "REPORTING"],
      visible_schemas: { APP_USER: ["ARCHIVE"] },
    });

    expect(options).toEqual(["ARCHIVE"]);
  });

  it("preserves listDatabases and visible database filtering for other databases", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "analytics" }, { name: "postgres" }]);

    const options = await fetchSqlFileTargetOptions("connection-2", {
      db_type: "postgres",
      database: "app",
      visible_databases: ["analytics"],
    });

    expect(options).toEqual(["analytics"]);
    expect(mocks.listDatabases).toHaveBeenCalledWith("connection-2");
    expect(mocks.listSchemas).not.toHaveBeenCalled();
  });

  it("propagates metadata loading errors", async () => {
    const error = new Error("schema metadata failed");
    mocks.listSchemas.mockRejectedValue(error);

    await expect(
      fetchSqlFileTargetOptions("connection-1", {
        db_type: "dameng",
        database: "APP_USER",
      }),
    ).rejects.toBe(error);
  });
});
