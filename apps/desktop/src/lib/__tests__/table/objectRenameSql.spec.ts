import { describe, expect, it } from "vitest";

import { databaseRenameMaintenanceDatabase, supportsDatabaseRename } from "@/lib/table/objectRenameSql";

describe("database rename", () => {
  it("chooses a maintenance database outside the rename target", () => {
    expect(databaseRenameMaintenanceDatabase("admin", "application")).toBe("admin");
    expect(databaseRenameMaintenanceDatabase("application", "application")).toBe("postgres");
    expect(databaseRenameMaintenanceDatabase(undefined, "application")).toBe("postgres");
    expect(databaseRenameMaintenanceDatabase("postgres", "postgres")).toBe("template1");
    expect(databaseRenameMaintenanceDatabase("template1", "postgres")).toBe("template1");
  });

  it("does not expose database rename for YashanDB", () => {
    expect(supportsDatabaseRename("postgres")).toBe(true);
    expect(supportsDatabaseRename("yashandb")).toBe(false);
  });
});
