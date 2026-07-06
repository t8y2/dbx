import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeObjectSourceSave } from "@/lib/table/objectSourceEditor";

vi.mock("@/lib/backend/api", () => ({
  executeInTransaction: vi.fn().mockResolvedValue({}),
  executeQuery: vi.fn().mockResolvedValue({}),
  executeScript: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeObjectSourceSave", () => {
  it("runs multi-statement Informix source saves in a transaction", async () => {
    await executeObjectSourceSave("conn-1", "stores", "informix", ["CREATE TEMP VIEW v AS SELECT 1", "  ", "DROP VIEW v", "CREATE VIEW v AS SELECT 2"], "app");

    expect(api.executeInTransaction).toHaveBeenCalledOnce();
    expect(api.executeInTransaction).toHaveBeenCalledWith("conn-1", "stores", ["CREATE TEMP VIEW v AS SELECT 1", "DROP VIEW v", "CREATE VIEW v AS SELECT 2"], "app");
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeScript).not.toHaveBeenCalled();
  });

  it("keeps non-Informix source saves on the existing per-statement path", async () => {
    await executeObjectSourceSave("conn-1", "app", "mysql", ["ALTER VIEW v AS SELECT 1", "", "ALTER VIEW v AS SELECT 2"], "public");

    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery).toHaveBeenNthCalledWith(1, "conn-1", "app", "ALTER VIEW v AS SELECT 1", "public");
    expect(api.executeQuery).toHaveBeenNthCalledWith(2, "conn-1", "app", "ALTER VIEW v AS SELECT 2", "public");
    expect(api.executeScript).not.toHaveBeenCalled();
  });
});
