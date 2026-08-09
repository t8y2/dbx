import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  getObjectSource: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMocks);

import { loadRoutineParameters } from "@/lib/table/routineParameters";

describe("XuguDB routine parameter loading", () => {
  beforeEach(() => {
    apiMocks.executeQuery.mockReset();
    apiMocks.getObjectSource.mockReset();
  });

  it("loads the procedure definition on demand and parses its parameters", async () => {
    apiMocks.getObjectSource.mockResolvedValue({
      name: "save_value",
      object_type: "PROCEDURE",
      schema: "AppSchema",
      source: "CREATE PROCEDURE save_value(p_id IN INTEGER, p_message OUT VARCHAR(100)) AS BEGIN NULL; END;",
    });

    await expect(
      loadRoutineParameters({
        connectionId: "connection-1",
        database: "sample",
        databaseType: "xugu",
        schema: "AppSchema",
        routineName: "save_value",
      }),
    ).resolves.toEqual([
      { name: "p_id", dataType: "INTEGER", mode: "IN", ordinal: 1, hasDefault: false, defaultValue: undefined },
      { name: "p_message", dataType: "VARCHAR(100)", mode: "OUT", ordinal: 2, hasDefault: false, defaultValue: undefined },
    ]);

    expect(apiMocks.getObjectSource).toHaveBeenCalledWith("connection-1", "sample", "AppSchema", "save_value", "PROCEDURE");
    expect(apiMocks.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the selected database as the schema fallback", async () => {
    apiMocks.getObjectSource.mockResolvedValue({ name: "ping", object_type: "PROCEDURE", source: "CREATE PROCEDURE ping AS BEGIN NULL; END;" });

    await loadRoutineParameters({ connectionId: "connection-1", database: "sample", databaseType: "xugu", routineName: "ping" });

    expect(apiMocks.getObjectSource).toHaveBeenCalledWith("connection-1", "sample", "sample", "ping", "PROCEDURE");
  });
});
