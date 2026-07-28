import { describe, expect, it } from "vitest";
import { dataTabExecutionDatabase } from "@/lib/table/dataTabExecutionDatabase";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Test",
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
    ...overrides,
  };
}

describe("dataTabExecutionDatabase", () => {
  it("uses the configured database for a Doris external catalog", () => {
    expect(dataTabExecutionDatabase(connection({ db_type: "doris", database: "yunye" }), "default", "iceberg_catalog")).toBe("yunye");
  });

  it("allows no session database for a Doris external catalog", () => {
    expect(dataTabExecutionDatabase(connection({ db_type: "doris" }), "default", "iceberg_catalog")).toBe("");
  });

  it("uses the configured database for a StarRocks external catalog", () => {
    expect(dataTabExecutionDatabase(connection({ db_type: "starrocks", database: "analytics" }), "default", "iceberg_catalog")).toBe("analytics");
  });

  it("recognizes Doris JDBC connections", () => {
    expect(dataTabExecutionDatabase(connection({ db_type: "jdbc", connection_string: "jdbc:mysql://localhost:9030/db?product=doris", database: "internal_db" }), "default", "iceberg_catalog")).toBe("internal_db");
  });

  it("keeps the tab database for internal and ordinary tables", () => {
    expect(dataTabExecutionDatabase(connection({ db_type: "doris", database: "configured" }), "internal_db")).toBe("internal_db");
    expect(dataTabExecutionDatabase(connection({ db_type: "mysql", database: "configured" }), "tenant_db", "catalog_like_value")).toBe("tenant_db");
  });
});
