import { describe, expect, it } from "vitest";
import { schemaAfterConnectionSwitch } from "@/lib/schema/connectionSchemaInitialization";

describe("schemaAfterConnectionSwitch", () => {
  it("selects the current Oracle schema from the raw ordered result", () => {
    expect(schemaAfterConnectionSwitch("oracle", ["CONNECTED_USER", "APP", "SYSTEM"])).toBe("CONNECTED_USER");
  });

  it("does not initialize schemas for non-Oracle connections", () => {
    expect(schemaAfterConnectionSwitch("postgres", ["public", "archive"])).toBeUndefined();
  });

  it("prefers a configured default schema for PostgreSQL and Oracle", () => {
    expect(schemaAfterConnectionSwitch("postgres", ["public", "archive"], "archive")).toBe("archive");
    expect(schemaAfterConnectionSwitch("oracle", ["CONNECTED_USER", "APP"], "APP")).toBe("APP");
  });
});
