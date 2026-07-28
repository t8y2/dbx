import { describe, expect, it } from "vitest";
import { schemaAfterConnectionSwitch } from "@/lib/schema/connectionSchemaInitialization";

describe("schemaAfterConnectionSwitch", () => {
  it("selects the current Oracle schema from the raw ordered result", () => {
    expect(schemaAfterConnectionSwitch("oracle", ["CONNECTED_USER", "APP", "SYSTEM"])).toBe("CONNECTED_USER");
  });

  it("does not initialize schemas for non-Oracle connections", () => {
    expect(schemaAfterConnectionSwitch("postgres", ["public", "archive"])).toBeUndefined();
  });
});
