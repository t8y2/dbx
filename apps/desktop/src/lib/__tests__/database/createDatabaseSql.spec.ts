import { describe, expect, it } from "vitest";
import { attachedDatabaseNameFromPath, uniqueAttachedDatabaseName } from "@/lib/database/createDatabaseSql";

describe("SQLite attached database names", () => {
  it("moves reserved aliases to the next available suffix", () => {
    const baseName = attachedDatabaseNameFromPath("/tmp/temp.sqlite", "sqlite_database");

    expect(uniqueAttachedDatabaseName(baseName, ["main"], ["main", "temp"])).toBe("temp_2");
    expect(uniqueAttachedDatabaseName("MAIN", [], ["main", "temp"])).toBe("MAIN_2");
  });

  it("keeps checking existing aliases after a reserved-name collision", () => {
    expect(uniqueAttachedDatabaseName("temp", ["temp_2", "temp_3"], ["main", "temp"])).toBe("temp_4");
  });
});
