import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("SQL Server table-valued function completion (#13131)", () => {
  // Mirrors the completion assistant contract: IF/TF/FT functions report the
  // "table" return kind, scalar FN/FS functions report their return type name,
  // and objects from paths without return-type metadata carry no dataType.
  const objects = [
    { name: "SplitCsv", schema: "dbo", type: "function" as const, dataType: "table", signature: "@csv NVARCHAR(MAX)" },
    { name: "TotalSales", schema: "dbo", type: "function" as const, dataType: "table" },
    { name: "GetCustomerName", schema: "dbo", type: "function" as const, dataType: "nvarchar" },
    { name: "UnknownKind", schema: "dbo", type: "function" as const },
    { name: "ArchiveOldOrders", schema: "dbo", type: "procedure" as const },
  ];

  function itemsFor(sql: string) {
    return buildSqlCompletionItems(sql, sql.length, {
      databaseType: "sqlserver",
      tables: [{ name: "orders" }, { name: "customers" }],
      objects,
      columnsByTable: new Map(),
    });
  }

  function labelsFor(sql: string) {
    return itemsFor(sql).map((item) => item.label);
  }

  it("offers only table-valued functions as relation sources after FROM", () => {
    const labels = labelsFor("SELECT * FROM ");
    expect(labels).toEqual(expect.arrayContaining(["SplitCsv", "TotalSales"]));
    expect(labels).not.toContain("GetCustomerName");
    expect(labels).not.toContain("UnknownKind");
    expect(labels).not.toContain("ArchiveOldOrders");
  });

  it("keeps table-valued functions behind a schema qualifier", () => {
    const labels = labelsFor("SELECT * FROM dbo.");
    expect(labels).toEqual(expect.arrayContaining(["SplitCsv"]));
    expect(labels).not.toContain("GetCustomerName");
  });

  it("inserts the parameterized call for functions with a known signature", () => {
    const item = itemsFor("SELECT * FROM Sp").find((item) => item.label === "SplitCsv");
    expect(item?.apply).toBe("SplitCsv(${1:@csv NVARCHAR(MAX)})");
  });

  it("still completes scalar functions in the SELECT expression context", () => {
    const labels = labelsFor("SELECT GetCust");
    expect(labels).toContain("GetCustomerName");
  });

  it("inserts a call for zero-argument and signature-less table-valued functions", () => {
    // A TVF is a relation source only in call form: even without a signature
    // the insert is `TotalSales()`, never the bare name (t8y2/dbx#13394).
    const item = itemsFor("SELECT * FROM TotalSal").find((entry) => entry.label === "TotalSales");
    expect(item?.apply).toBe("TotalSales()");
  });

  it("keeps TVFs of other schemas out of a schema-qualified FROM", () => {
    // dbo.DboRows and archive.ArchiveOnly live in different schemas with
    // different signatures; `FROM dbo.` must offer and insert only the dbo
    // one, with dbo's signature (t8y2/dbx#13394 review).
    const scoped = [...objects, { name: "DboRows", schema: "dbo", type: "function" as const, dataType: "table", signature: "@top INT" }, { name: "ArchiveOnly", schema: "archive", type: "function" as const, dataType: "table", signature: "@from DATE" }];
    const item = buildSqlCompletionItems("SELECT * FROM dbo.", 20, {
      databaseType: "sqlserver",
      tables: [{ name: "orders" }],
      objects: scoped,
      columnsByTable: new Map(),
    }).find((entry) => entry.label === "DboRows");
    expect(item).toBeDefined();
    expect(item?.apply).toBe("DboRows(${1:@top INT})");
    const labels = buildSqlCompletionItems("SELECT * FROM dbo.", 20, {
      databaseType: "sqlserver",
      tables: [{ name: "orders" }],
      objects: scoped,
      columnsByTable: new Map(),
    }).map((entry) => entry.label);
    expect(labels).not.toContain("ArchiveOnly");
  });

  it("inserts the dbo signature when the same TVF name exists in two schemas", () => {
    // The schema scope above also keeps the signature lookup from crossing
    // schemas when names collide (t8y2/dbx#13394 review).
    const colliding = [
      { name: "SplitCsv", schema: "dbo", type: "function" as const, dataType: "table", signature: "@csv NVARCHAR(MAX)" },
      { name: "SplitCsv", schema: "archive", type: "function" as const, dataType: "table", signature: "@legacy INT" },
    ];
    const item = buildSqlCompletionItems("SELECT * FROM dbo.Split", 22, {
      databaseType: "sqlserver",
      tables: [{ name: "orders" }],
      objects: colliding,
      columnsByTable: new Map(),
    }).find((entry) => entry.label === "SplitCsv");
    expect(item?.apply).toBe("SplitCsv(${1:@csv NVARCHAR(MAX)})");
  });

  it("does not offer sqlserver metadata objects to other engines", () => {
    const labels = buildSqlCompletionItems("SELECT * FROM ", 14, {
      databaseType: "mysql",
      tables: [{ name: "orders" }],
      objects: [{ name: "SplitCsv", schema: "dbo", type: "function", dataType: "table" }],
      columnsByTable: new Map(),
    }).map((item) => item.label);
    expect(labels).not.toContain("SplitCsv");
  });
});
