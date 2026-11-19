import { describe, expect, it } from "vitest";
import { supportsDatabaseCompare } from "@/lib/database/databaseCompareCapabilities";

describe("databaseCompareCapabilities", () => {
  it("reads comparison support from the shared driver manifest", () => {
    expect(supportsDatabaseCompare({ db_type: "mysql" }, "schema")).toBe(true);
    expect(supportsDatabaseCompare({ db_type: "kingbase" }, "data")).toBe(true);
    expect(supportsDatabaseCompare({ db_type: "mongodb" }, "data")).toBe(false);
    expect(supportsDatabaseCompare({ db_type: "redis" }, "schema")).toBe(false);
  });

  it("applies manifest support after resolving a JDBC product dialect", () => {
    expect(supportsDatabaseCompare({ db_type: "jdbc", connection_string: "jdbc:postgresql://localhost:5432/app" }, "data")).toBe(true);
    expect(supportsDatabaseCompare({ db_type: "jdbc", driver_profile: "unknown-product" }, "data")).toBe(false);
  });
});
