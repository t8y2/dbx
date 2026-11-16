import { describe, expect, it } from "vitest";
import { schemaDiffEngineDatabaseType } from "@/lib/schema/schemaDiff";

describe("schemaDiffEngineDatabaseType", () => {
  it("resolves the product type of a JDBC connection from the driver profile", () => {
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc", driver_profile: "jdbc-oracle" })).toBe("oracle");
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc", driver_profile: "jdbc-mysql" })).toBe("mysql");
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc", driver_profile: "jdbc-postgresql" })).toBe("postgres");
  });

  it("resolves the product type from the JDBC URL, driver class and labels", () => {
    expect(
      schemaDiffEngineDatabaseType({
        db_type: "jdbc",
        connection_string: "jdbc:oracle:thin:@192.168.58.103:15211:XE",
        jdbc_driver_class: "oracle.jdbc.OracleDriver",
      }),
    ).toBe("oracle");
    expect(
      schemaDiffEngineDatabaseType({
        db_type: "jdbc",
        jdbc_driver_paths: ["/plugins/jdbc/drivers/local/ojdbc8-21.9.0.0.jar"],
        jdbc_driver_class: "com.mysql.cj.jdbc.Driver",
        connection_string: "jdbc:mysql://127.0.0.1:3306/db",
      }),
    ).toBe("mysql");
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc", driver_label: "Apache Hive" })).toBe("hive");
  });

  it("keeps generic JDBC connections on the generic type", () => {
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc" })).toBe("jdbc");
    expect(schemaDiffEngineDatabaseType({ db_type: "jdbc", driver_profile: "jdbcx" })).toBe("jdbc");
  });

  it("leaves non-JDBC connections untouched", () => {
    expect(schemaDiffEngineDatabaseType({ db_type: "oracle" })).toBe("oracle");
    expect(schemaDiffEngineDatabaseType({ db_type: "mysql", driver_profile: "starrocks" })).toBe("mysql");
    expect(schemaDiffEngineDatabaseType({ db_type: "postgres" })).toBe("postgres");
    expect(schemaDiffEngineDatabaseType(undefined)).toBeUndefined();
  });
});
