import { describe, expect, it } from "vitest";
import { usesLightweightMysqlBrowser } from "../mysqlBrowserLoading";

describe("native MySQL browser loading policy", () => {
  it.each([undefined, "", "   ", "mysql", " MYSQL "])("allows plain MySQL profile %s", (driver_profile) => {
    expect(usesLightweightMysqlBrowser({ db_type: "mysql", driver_profile, database_info: { productVersion: "5.5.61-38.13", serverComment: "Percona Server" } })).toBe(true);
  });
  it.each(["dolt", "sphinx", "tdsql", "tidb", "starrocks", "selectdb"])("keeps explicit profile %s on its existing path", (driver_profile) => {
    expect(usesLightweightMysqlBrowser({ db_type: "mysql", driver_profile })).toBe(false);
  });
  it.each([{ productVersion: "5.6-MyCat" }, { serverComment: "MYCAT server" }, { productVersion: "5.7-ShardingSphere-Proxy" }])("excludes detected proxy %j", (database_info) => {
    expect(usesLightweightMysqlBrowser({ db_type: "mysql", database_info })).toBe(false);
  });
  it.each(["jdbc", "oracle", "postgres"] as const)("does not change %s", (db_type) => {
    expect(usesLightweightMysqlBrowser({ db_type })).toBe(false);
  });
});
