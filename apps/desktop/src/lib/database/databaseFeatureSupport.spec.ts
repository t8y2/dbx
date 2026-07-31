import { describe, expect, it } from "vitest";
import { supportsConnectionQueryActions } from "./databaseFeatureSupport";

describe("supportsConnectionQueryActions", () => {
  it("keeps administration-only connection types out of SQL menus", () => {
    expect(supportsConnectionQueryActions("docker")).toBe(false);
    expect(supportsConnectionQueryActions("nacos")).toBe(false);
    expect(supportsConnectionQueryActions("hbase")).toBe(false);
    expect(supportsConnectionQueryActions("mysql")).toBe(true);
  });
});
