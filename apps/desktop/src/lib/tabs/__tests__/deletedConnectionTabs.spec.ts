import { describe, expect, it } from "vitest";
import { deletedConnectionTabKeepMode } from "@/lib/tabs/deletedConnectionTabs";

describe("deletedConnectionTabKeepMode", () => {
  it("maps each delete-time tab handling mode to its keep scope", () => {
    expect(deletedConnectionTabKeepMode("close-tabs")).toBe("none");
    expect(deletedConnectionTabKeepMode("keep-sql-tabs")).toBe("sql");
    expect(deletedConnectionTabKeepMode("keep-pinned-sql-tabs")).toBe("pinned-sql");
    expect(deletedConnectionTabKeepMode("keep-all-tabs")).toBe("all");
  });
});
