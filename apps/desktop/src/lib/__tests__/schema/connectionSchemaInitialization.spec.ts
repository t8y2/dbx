import { describe, expect, it } from "vitest";
import { schemaAfterConnectionSwitch } from "@/lib/schema/connectionSchemaInitialization";

describe("schemaAfterConnectionSwitch", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("selects the current %s schema from the raw ordered result", (databaseType) => {
    expect(schemaAfterConnectionSwitch(databaseType, ["CURRENT_OWNER", "LOGIN_USER", "APP"])).toBe("CURRENT_OWNER");
    expect(schemaAfterConnectionSwitch(databaseType, [])).toBeUndefined();
  });

  it("does not initialize schemas for non-Oracle connections", () => {
    expect(schemaAfterConnectionSwitch("postgres", ["public", "archive"])).toBeUndefined();
  });

  it.each(["postgres", "oracle", "oceanbase-oracle"] as const)("prefers a configured default schema for %s", (databaseType) => {
    expect(schemaAfterConnectionSwitch(databaseType, ["CURRENT_OWNER", "APP"], " APP ")).toBe("APP");
  });
});
