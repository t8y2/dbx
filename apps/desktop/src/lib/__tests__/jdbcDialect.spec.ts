import { describe, expect, it } from "vitest";
import { effectiveDatabaseTypeForConnection, inferJdbcDialect } from "@/lib/jdbcDialect";

describe("jdbc dialect inference", () => {
  it("detects InterSystems IRIS and Caché JDBC connections", () => {
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        connection_string: "jdbc:Cache://localhost:1972/USER",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_class: "com.intersystems.jdbc.IRISDriver",
      }),
    ).toBe("iris");
    expect(
      inferJdbcDialect({
        db_type: "jdbc",
        jdbc_driver_paths: ["/drivers/intersystems-jdbc-3.10.5.jar"],
      }),
    ).toBe("iris");
  });

  it("uses IRIS table preview dialect for generic JDBC IRIS connections", () => {
    expect(
      effectiveDatabaseTypeForConnection({
        db_type: "jdbc",
        connection_string: "jdbc:IRIS://localhost:1972/USER",
      }),
    ).toBe("iris");
  });
});
