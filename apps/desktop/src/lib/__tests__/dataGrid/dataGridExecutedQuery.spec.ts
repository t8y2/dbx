import { describe, expect, it } from "vitest";
import { dataGridExecutedQueryConditions } from "@/lib/dataGrid/dataGridExecutedQuery";

describe("executed table query conditions", () => {
  it.each(["mysql", "postgres", "dameng", "sqlite"] as const)("extracts %s conditions without pagination or quoted keywords", (databaseType) => {
    const sql = "SELECT * FROM app.orders WHERE status = 4 AND note = 'ORDER BY LIMIT ;' AND id IN (SELECT id FROM orders WHERE status = 8 ORDER BY id) ORDER BY id DESC, status ASC LIMIT 100 OFFSET 200;";
    expect(dataGridExecutedQueryConditions(sql, "orders", databaseType)).toEqual({
      whereInput: "status = 4 AND note = 'ORDER BY LIMIT ;' AND id IN (SELECT id FROM orders WHERE status = 8 ORDER BY id)",
      orderBy: "id DESC, status ASC",
    });
  });

  it.each([0, 200])("uses the Oracle base query rather than ROWNUM predicates at offset %i", (offset) => {
    const inner = 'SELECT "ID", DBMS_LOB.SUBSTR("BODY", 1000, 1) AS "BODY", \'T:999:\' || DBMS_LOB.GETLENGTH("BODY") AS "__DBX_LARGE_VALUE_BYTES_T_1" FROM "APP"."ORDERS" WHERE "STATUS" = 4 ORDER BY "ID" DESC';
    const sql =
      offset === 0 ? `SELECT "ID", "BODY", "__DBX_LARGE_VALUE_BYTES_T_1" FROM (${inner}) WHERE ROWNUM <= 100` : `SELECT "ID", "BODY", "__DBX_LARGE_VALUE_BYTES_T_1" FROM (SELECT dbx_inner.*, ROWNUM AS "__dbx_row_num" FROM (${inner}) dbx_inner WHERE ROWNUM <= 300) WHERE "__dbx_row_num" > 200`;
    expect(dataGridExecutedQueryConditions(sql, "ORDERS", "oracle")).toEqual({ whereInput: '"STATUS" = 4', orderBy: '"ID" DESC' });
  });

  it("ignores clause keywords inside comments, identifiers and subqueries", () => {
    const sql = 'SELECT * FROM "orders" WHERE "order" = \'where\' /* ORDER BY ignored */ AND EXISTS (SELECT 1 FROM other WHERE active = 1) ORDER BY "limit" DESC FETCH FIRST 100 ROWS ONLY';
    expect(dataGridExecutedQueryConditions(sql, "orders", "postgres")).toEqual({
      whereInput: "\"order\" = 'where' /* ORDER BY ignored */ AND EXISTS (SELECT 1 FROM other WHERE active = 1)",
      orderBy: '"limit" DESC',
    });
  });

  it("does not invent filters or sorting for an unfiltered page", () => {
    expect(dataGridExecutedQueryConditions("SELECT * FROM orders LIMIT 100;", "orders", "mysql")).toEqual({ whereInput: undefined, orderBy: undefined });
  });

  it.each(["SELECT * FROM other WHERE status = 4", "SELECT * FROM orders JOIN other ON orders.id = other.id", "SELECT status, COUNT(*) FROM orders GROUP BY status", "SELECT * FROM orders UNION SELECT * FROM archive", "SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn FROM orders"])(
    "declines unsupported reconstruction shapes: %s",
    (sql) => {
      expect(dataGridExecutedQueryConditions(sql, "orders", "sqlserver")).toBeNull();
    },
  );
});
