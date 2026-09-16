import { describe, expect, it } from "vitest";
import { dataGridConditionColumnOptions, dataGridConditionIdentifierQuote, dataGridFilterColumns } from "@/lib/dataGrid/dataGridConditionCompletion";

function column(name: string, dataType: string) {
  return {
    name,
    data_type: dataType,
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

describe("dataGridConditionColumnOptions", () => {
  it("reuses PostgreSQL completion quoting while preserving display metadata", () => {
    expect(dataGridConditionColumnOptions([{ name: "OrderId", comment: "Mixed case" }, { name: "order", comment: null }, { name: "article", comment: "Safe identifier" }, { name: 'has"quote' }], "postgres")).toEqual([
      { name: "OrderId", comment: "Mixed case", insertText: '"OrderId"' },
      { name: "order", comment: null, insertText: '"order"' },
      { name: "article", comment: "Safe identifier", insertText: "article" },
      { name: 'has"quote', insertText: '"has""quote"' },
    ]);
  });

  it.each(["mysql", "sqlserver", "oracle"] as const)("keeps existing %s condition insertions unchanged", (databaseType) => {
    expect(dataGridConditionColumnOptions(["OrderId", "order"], databaseType)).toEqual([
      { name: "OrderId", insertText: "OrderId" },
      { name: "order", insertText: "order" },
    ]);
  });

  it("uses the active dialect identifier quote while preserving runtime overrides", () => {
    expect(dataGridConditionIdentifierQuote("postgres")).toBe('"');
    expect(dataGridConditionIdentifierQuote("oracle")).toBe('"');
    expect(dataGridConditionIdentifierQuote("sqlite")).toBe('"');
    expect(dataGridConditionIdentifierQuote("mysql")).toBe("`");
    expect(dataGridConditionIdentifierQuote("kingbase", "`")).toBe("`");
  });
});

describe("dataGridFilterColumns", () => {
  it.each(["ms", "us", "ns"])("adds metadata-less IoTDB Tree Time for %s precision", (precision) => {
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType: "iotdb",
        context: "table-data",
        urlParams: "time_zone=Asia%2FShanghai",
        tableColumns: [value],
        resultColumns: ["Time", "value"],
        resultColumnTypes: [`TIMESTAMP(${precision})`, "DOUBLE"],
      }),
    ).toEqual([{ name: "Time" }, { name: "value", columnInfo: value }]);
  });

  it("lets URL params override the same connection-string dialect key", () => {
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType: "iotdb",
        context: "table-data",
        connectionString: "jdbc:iotdb://localhost:6667/root.db?sql_dialect=table",
        urlParams: "sql_dialect=tree",
        tableColumns: [value],
        resultColumns: ["Time", "value"],
        resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"],
      }),
    ).toEqual([{ name: "Time" }, { name: "value", columnInfo: value }]);
  });

  it("keeps explicit Tree Time metadata exactly once", () => {
    const time = column("Time", "TIMESTAMP");
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType: "iotdb",
        context: "table-data",
        urlParams: "sql_dialect=tree",
        tableColumns: [time, value],
        resultColumns: ["Time", "value"],
        resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"],
      }),
    ).toEqual([
      { name: "Time", columnInfo: time },
      { name: "value", columnInfo: value },
    ]);
  });

  it.each([{ urlParams: "sql_dialect=table" }, { urlParams: "DIALECT=TABLE" }, { connectionString: "jdbc:iotdb://localhost:6667/root.db?sql_dialect=table" }] as const)("does not synthesize Time for IoTDB Table dialect ($urlParams$connectionString)", (connection) => {
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType: "iotdb",
        context: "table-data",
        ...connection,
        tableColumns: [value],
        resultColumns: ["Time", "value"],
        resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"],
      }),
    ).toEqual([{ name: "value", columnInfo: value }]);
  });

  it.each([
    { name: "query results", context: "results", databaseType: "iotdb", resultColumns: ["Time", "value"], resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"] },
    { name: "non-IoTDB", context: "table-data", databaseType: "mysql", resultColumns: ["Time", "value"], resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"] },
    { name: "non-leading Time", context: "table-data", databaseType: "iotdb", resultColumns: ["value", "Time"], resultColumnTypes: ["DOUBLE", "TIMESTAMP(ms)"] },
    { name: "non-canonical time", context: "table-data", databaseType: "iotdb", resultColumns: ["time", "value"], resultColumnTypes: ["TIMESTAMP(ms)", "DOUBLE"] },
    { name: "unqualified timestamp", context: "table-data", databaseType: "iotdb", resultColumns: ["Time", "value"], resultColumnTypes: ["TIMESTAMP", "DOUBLE"] },
  ] as const)("keeps physical candidates unchanged for $name", ({ context, databaseType, resultColumns, resultColumnTypes }) => {
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType,
        context,
        tableColumns: [value],
        resultColumns,
        resultColumnTypes,
      }),
    ).toEqual([{ name: "value", columnInfo: value }]);
  });

  it("does not duplicate a case-variant metadata Time column", () => {
    const time = column("time", "TIMESTAMP");
    const value = column("value", "DOUBLE");

    expect(
      dataGridFilterColumns({
        databaseType: "iotdb",
        context: "table-data",
        tableColumns: [time, value],
        resultColumns: ["Time", "value"],
        resultColumnTypes: ["TIMESTAMP(ns)", "DOUBLE"],
      }),
    ).toEqual([
      { name: "time", columnInfo: time },
      { name: "value", columnInfo: value },
    ]);
  });
});
