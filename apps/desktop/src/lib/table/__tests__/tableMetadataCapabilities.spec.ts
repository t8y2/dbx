import { describe, expect, it } from "vitest";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";

describe("tableMetadataCapabilities", () => {
  it("exposes only collection indexes for MongoDB table information", () => {
    expect(getTableMetadataCapabilities("mongodb")).toEqual({
      columns: false,
      indexes: true,
      foreignKeys: false,
      triggers: false,
      ddl: false,
    });
  });
});
