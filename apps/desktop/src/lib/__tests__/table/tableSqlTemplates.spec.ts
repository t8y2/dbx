import { describe, expect, it } from "vitest";

import { buildTableSelectTemplate, buildTableUpdateTemplate } from "@/lib/table/tableSqlTemplates";

describe("buildTableSelectTemplate", () => {
  it("can omit identifier quotes for a new-query table reference", () => {
    expect(
      buildTableSelectTemplate({
        databaseType: "postgres",
        schema: "public",
        tableName: "dbx_smoke",
        quoteIdentifiers: false,
      }),
    ).toBe("SELECT *\nFROM public.dbx_smoke;");
  });

  it("keeps required quotes for columns when identifier quoting is disabled", () => {
    expect(
      buildTableSelectTemplate({
        databaseType: "dameng",
        tableName: "DBX_TEST",
        columns: [
          { name: "ORDER", data_type: "VARCHAR" },
          { name: "CUSTOMER_NAME", data_type: "VARCHAR" },
        ],
        quoteIdentifiers: false,
      }),
    ).toBe('SELECT "ORDER", CUSTOMER_NAME\nFROM DBX_TEST;');
  });

  it("applies the same identifier policy to update templates", () => {
    expect(
      buildTableUpdateTemplate({
        databaseType: "oracle",
        tableName: "DBX_TEST",
        columns: [
          { name: "ID", data_type: "NUMBER", is_primary_key: true },
          { name: "ORDER", data_type: "VARCHAR" },
        ],
        quoteIdentifiers: false,
      }),
    ).toBe("UPDATE DBX_TEST\nSET \"ORDER\" = 'ORDER_value'\nWHERE ID = 0;");
  });
});
