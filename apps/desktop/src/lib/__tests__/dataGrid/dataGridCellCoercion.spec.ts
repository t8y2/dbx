import { describe, expect, it } from "vitest";
import { coerceDataGridCellValue, dataGridCellDisplayText, dataGridCellEditorText } from "@/lib/dataGrid/dataGridCellCoercion";
import { binaryCellClipboardText, canDownloadBinaryCellValue, parseBinaryCellBytes } from "@/lib/dataGrid/binaryCellDownload";

describe("dataGridCellEditorText", () => {
  it("decodes hex-encoded ASCII UUID values to readable UUID strings in uuid columns (#12911)", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    expect(
      dataGridCellEditorText({
        value: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");

    // Ordinary binary and varbinary columns preserve canonical hex form
    expect(
      dataGridCellEditorText({
        value: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "binary(36)" },
      }),
    ).toBe(hex);
    expect(
      dataGridCellEditorText({
        value: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "varbinary(36)" },
      }),
    ).toBe(hex);
    expect(
      dataGridCellEditorText({
        value: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "binary" },
      }),
    ).toBe(hex);
  });

  it("decodes 16-byte raw hex UUIDs in uuid columns to hyphenated UUID strings", () => {
    expect(
      dataGridCellEditorText({
        value: "0x01a057bf2bbd70a6b3c356eb409a0f95",
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");
  });

  it("preserves plain UUID strings and arbitrary binary data", () => {
    expect(
      dataGridCellEditorText({
        value: "01a057bf-2bbd-70a6-b3c3-56eb409a0f95",
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");

    expect(
      dataGridCellEditorText({
        value: "0x01020304",
        databaseType: "mysql",
        columnInfo: { data_type: "binary(4)" },
      }),
    ).toBe("0x01020304");
  });
});

describe("dataGridCellDisplayText", () => {
  it("keeps precision-sensitive decimal text through editor display and unchanged commit coercion", () => {
    const value = "9007199254740993.123456789012";
    expect(dataGridCellEditorText({ value, databaseType: "oceanbase-oracle", columnInfo: { data_type: "NUMBER(38,12)" } })).toBe(value);
    expect(
      coerceDataGridCellValue({
        value,
        oldValue: value,
        databaseType: "oceanbase-oracle",
        columnInfo: { data_type: "NUMBER(38,12)" },
      }),
    ).toBe(value);
  });

  it("formats Oracle DATE values without RFC3339 separators", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T09:58:43Z",
        databaseType: "oracle",
        columnInfo: { data_type: "DATE" },
      }),
    ).toBe("2022-08-25 09:58:43");
  });

  it("formats midnight Oracle DATE values as a date", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T00:00:00Z",
        databaseType: "oracle",
        columnInfo: { data_type: "DATE" },
      }),
    ).toBe("2022-08-25");
  });

  it("does not format non-date Oracle strings", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T09:58:43Z",
        databaseType: "oracle",
        columnInfo: { data_type: "VARCHAR2(64)" },
      }),
    ).toBeUndefined();
  });

  it.each([
    ["2026-08-28 12:34:56.1", "2026-08-28 12:34:56.100"],
    ["2026-08-28 12:34:56.12+08:00", "2026-08-28 12:34:56.120+08:00"],
  ])("pads short timestamp fractions for display", (value, expected) => {
    expect(
      dataGridCellDisplayText({
        value,
        databaseType: "mysql",
        columnInfo: { data_type: "timestamp" },
      }),
    ).toBe(expected);
  });

  it("leaves full-precision and non-timestamp values unchanged", () => {
    expect(
      dataGridCellDisplayText({
        value: "2026-08-28 12:34:56.1234",
        databaseType: "mysql",
        columnInfo: { data_type: "timestamp(6)" },
      }),
    ).toBeUndefined();
    expect(
      dataGridCellDisplayText({
        value: "2026-08-28 12:34:56.1",
        databaseType: "mysql",
        columnInfo: { data_type: "varchar(64)" },
      }),
    ).toBeUndefined();
  });
});

describe("coerceDataGridCellValue", () => {
  it.each(["Integer", "Long", "int"])("keeps Neo4j %s edits as exact text for the Cypher builder", (data_type) => {
    for (const value of ["1001", "9007199254740999", "9223372036854775807", "-9223372036854775808"]) {
      expect(coerceDataGridCellValue({ value, oldValue: "1", databaseType: "neo4j", columnInfo: { data_type } })).toBe(value);
      expect(coerceDataGridCellValue({ value: `${value}\n`, oldValue: "1", databaseType: "neo4j", columnInfo: { data_type } })).toBe(value);
    }
  });

  it.each(["null", "NULL", "Null", "nUlL"])("preserves literal %s input as text", (value) => {
    expect(
      coerceDataGridCellValue({
        value,
        oldValue: null,
        databaseType: "mysql",
        columnInfo: { data_type: "varchar(255)" },
      }),
    ).toBe(value);

    expect(
      coerceDataGridCellValue({
        value,
        oldValue: "previous",
        databaseType: "postgres",
        columnInfo: { data_type: "text" },
      }),
    ).toBe(value);
  });

  it("preserves an explicitly generated empty string for a null cell", () => {
    const options = {
      value: "",
      oldValue: null,
      databaseType: "mysql" as const,
      columnInfo: { data_type: "varchar(255)" },
    };

    expect(coerceDataGridCellValue(options)).toBeNull();
    expect(coerceDataGridCellValue({ ...options, preserveEmptyString: true })).toBe("");
  });

  it.each([
    ["a numeric column", "postgres" as const, { data_type: "integer" }],
    ["a boolean column", "postgres" as const, { data_type: "boolean" }],
    ["a MySQL TINYINT(1) column", "mysql" as const, { data_type: "tinyint(1)" }],
    ["a PostgreSQL array column", "postgres" as const, { data_type: "text[]" }],
    ["a date column", "postgres" as const, { data_type: "date" }],
    ["a timestamp column", "postgres" as const, { data_type: "timestamp without time zone" }],
    ["a time column", "mysql" as const, { data_type: "time" }],
    ["a uuid column", "postgres" as const, { data_type: "uuid" }],
    ["a jsonb column", "postgres" as const, { data_type: "jsonb" }],
    ["a bytea column", "postgres" as const, { data_type: "bytea" }],
    ["an unclassified column", "postgres" as const, { data_type: "some_custom_type" }],
    ["a column with no metadata", "postgres" as const, undefined],
  ])("keeps an empty string NULL in %s instead of coercing it", (_name, databaseType, columnInfo) => {
    const options = { value: "", oldValue: null, databaseType, columnInfo };

    expect(coerceDataGridCellValue({ ...options, preserveEmptyString: true })).toBeNull();
  });

  it.each([
    ["varchar", "mysql" as const, { data_type: "varchar(255)" }],
    ["text", "postgres" as const, { data_type: "text" }],
    ["char", "sqlserver" as const, { data_type: "char(4)" }],
    ["clob", "oracle" as const, { data_type: "clob" }],
  ])("keeps a pasted empty string in a %s column", (_name, databaseType, columnInfo) => {
    const options = { value: "", oldValue: null, databaseType, columnInfo };

    expect(coerceDataGridCellValue({ ...options, preserveEmptyString: true })).toBe("");
  });

  it.each([null, false, true])("coerces MySQL TINYINT(1) from metadata when the sampled value is %p", (oldValue) => {
    expect(
      coerceDataGridCellValue({
        value: "true",
        oldValue,
        databaseType: "mysql",
        columnInfo: { data_type: "TINYINT(1)" },
      }),
    ).toBe(true);
  });

  it.each(["0", "1"])("keeps numeric MySQL TINYINT(1) edits numeric for %s", (value) => {
    expect(
      coerceDataGridCellValue({
        value,
        oldValue: 0,
        databaseType: "mysql",
        columnInfo: { data_type: "TINYINT(1)" },
      }),
    ).toBe(Number(value));
  });

  it.each([
    ["missing numeric metadata", 1, undefined, "2", 2],
    ["empty numeric metadata", 1, { data_type: "" }, "2", 2],
    ["missing boolean metadata", false, undefined, "true", true],
    ["empty boolean metadata", true, { data_type: "" }, "0", false],
  ])("falls back to the sampled value type for %s", (_name, oldValue, columnInfo, value, expected) => {
    expect(
      coerceDataGridCellValue({
        value,
        oldValue,
        databaseType: "mysql",
        columnInfo,
      }),
    ).toBe(expected);
  });

  it("prefers column metadata over the sampled value type", () => {
    expect(
      coerceDataGridCellValue({
        value: "2",
        oldValue: 1,
        databaseType: "mysql",
        columnInfo: { data_type: "varchar(255)" },
      }),
    ).toBe("2");
  });

  it.each([
    ["numeric non-nullable", 42, "integer", false],
    ["boolean nullable", true, "boolean", true],
    ["text nullable", "before", "text", true],
    ["text non-nullable", "before", "varchar(255)", false],
    ["previously NULL text", null, "varchar(255)", true],
  ])("uses SQL NULL for an empty inline bulk edit in a %s cell", (_name, oldValue, dataType, _isNullable) => {
    expect(
      coerceDataGridCellValue({
        value: "",
        oldValue,
        databaseType: "postgres",
        columnInfo: { data_type: dataType },
        emptyStringAsNull: true,
      }),
    ).toBeNull();
  });

  it.each([
    ["numeric", 42, "integer", "7", 7],
    ["boolean", false, "boolean", "true", true],
    ["text", "before", "text", "after", "after"],
  ])("keeps per-column coercion for non-empty inline bulk edits: %s", (_name, oldValue, dataType, value, expected) => {
    expect(
      coerceDataGridCellValue({
        value,
        oldValue,
        databaseType: "postgres",
        columnInfo: { data_type: dataType },
        emptyStringAsNull: true,
      }),
    ).toBe(expected);
  });

  it("strips unambiguous thousands separators before numeric coercion", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,234.50",
        oldValue: 1234.5,
        databaseType: "sqlserver",
        columnInfo: { data_type: "float" },
      }),
    ).toBe(1234.5);

    expect(
      coerceDataGridCellValue({
        value: "1,234,567",
        oldValue: 1234567,
        databaseType: "sqlserver",
        columnInfo: { data_type: "int" },
      }),
    ).toBe(1234567);

    expect(
      coerceDataGridCellValue({
        value: "-10,000.00",
        oldValue: "-10000.00",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("-10000.00");
  });

  it("preserves exact text for grouped decimals", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000.00",
        oldValue: "10000.50",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("10000.00");
  });

  it("normalizes grouped mantissas with scientific notation", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,234.50e2",
        oldValue: "0",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("1234.50e2");

    expect(
      coerceDataGridCellValue({
        value: "-1,234.5E-2",
        oldValue: "0",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("-1234.5E-2");
  });

  it("preserves exact text for grouped integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(
      coerceDataGridCellValue({
        value: "9,007,199,254,740,993",
        oldValue: 9007199254740992,
        databaseType: "mysql",
        columnInfo: { data_type: "bigint" },
      }),
    ).toBe("9007199254740993");
  });

  it("normalizes ambiguous single-comma values using the runtime number format", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000",
        oldValue: "0.0000",
        databaseType: "mysql",
        columnInfo: { data_type: "decimal(14,4)" },
        numberFormat: { groupSeparator: ",", decimalSeparator: "." },
      }),
    ).toBe("10000");

    expect(
      coerceDataGridCellValue({
        value: "114,870",
        oldValue: "0.0000",
        databaseType: "mysql",
        columnInfo: { data_type: "decimal(14,4)" },
        numberFormat: { groupSeparator: ",", decimalSeparator: "." },
      }),
    ).toBe("114870");

    expect(
      coerceDataGridCellValue({
        value: "114,870",
        oldValue: "0.0000",
        databaseType: "mysql",
        columnInfo: { data_type: "decimal(14,4)" },
        numberFormat: { groupSeparator: ".", decimalSeparator: "," },
      }),
    ).toBe("114.870");

    expect(
      coerceDataGridCellValue({
        value: "1,000e3",
        oldValue: 1000000,
        databaseType: "sqlserver",
        columnInfo: { data_type: "float" },
        numberFormat: { groupSeparator: ".", decimalSeparator: "," },
      }),
    ).toBe(1000);
  });

  it("leaves ambiguous comma values untouched when the runtime format uses neither comma token", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000",
        oldValue: 10000,
        databaseType: "sqlserver",
        columnInfo: { data_type: "int" },
        numberFormat: { groupSeparator: "’", decimalSeparator: "." },
      }),
    ).toBe("10,000");
  });

  it("does not strip commas when the column is not numeric", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000.00",
        oldValue: "10,000.00",
        databaseType: "sqlserver",
        columnInfo: { data_type: "varchar(255)" },
      }),
    ).toBe("10,000.00");
  });

  it("leaves invalid thousand-grouping values untouched", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,23",
        oldValue: 123,
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("1,23");
  });

  it("handles UUID cell edits cleanly (#12911)", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    // Unchanged value preserves original hex oldValue
    expect(
      coerceDataGridCellValue({
        value: "01a057bf-2bbd-70a6-b3c3-56eb409a0f95",
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBe(hex);

    // Edited value in uuid column returns clean UUID string
    expect(
      coerceDataGridCellValue({
        value: "01a057bf-2bbd-70a6-b3c3-56eb409a0f99",
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f99");

    // Cleared value returns null
    expect(
      coerceDataGridCellValue({
        value: "",
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "uuid" },
      }),
    ).toBeNull();
  });

  it("preserves canonical hex edits in BINARY(36) and VARBINARY(36)", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    // Unchanged hex preserves oldValue
    expect(
      coerceDataGridCellValue({
        value: hex,
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "binary(36)" },
      }),
    ).toBe(hex);

    // Edited hex preserves new hex value
    const newHex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663939";
    expect(
      coerceDataGridCellValue({
        value: newHex,
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "binary(36)" },
      }),
    ).toBe(newHex);

    expect(
      coerceDataGridCellValue({
        value: newHex,
        oldValue: hex,
        databaseType: "mysql",
        columnInfo: { data_type: "varbinary(36)" },
      }),
    ).toBe(newHex);
  });
});

describe("binaryCellClipboardText", () => {
  it("copies hex-encoded UUID values as readable text for uuid columns (#12911)", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    expect(binaryCellClipboardText(hex, "uuid", "mysql")).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");
    expect(binaryCellClipboardText("0x01a057bf2bbd70a6b3c356eb409a0f95", "uuid", "mysql")).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");
  });

  it("preserves canonical hex or standard copy behavior for binary/varbinary storing ASCII UUID", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    // BINARY(36) keeps canonical hex (null return signals clipboard to copy raw hex)
    expect(binaryCellClipboardText(hex, "binary(36)", "mysql")).toBeNull();
    expect(binaryCellClipboardText(hex, "binary", "mysql")).toBeNull();
    // VARBINARY(36) in MySQL copies UTF-8 printable string per #7471
    expect(binaryCellClipboardText(hex, "varbinary(36)", "mysql")).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");
    expect(binaryCellClipboardText("0x01020304", "binary", "mysql")).toBeNull();
  });
});

describe("canDownloadBinaryCellValue and parseBinaryCellBytes", () => {
  it("allows downloading canonical hex in BINARY(36) and VARBINARY(36) even when storing ASCII UUID bytes", () => {
    const hex = "0x30316130353762662d326262642d373061362d623363332d353665623430396130663935";
    expect(canDownloadBinaryCellValue(hex, "binary(36)", "mysql")).toBe(true);
    expect(canDownloadBinaryCellValue(hex, "varbinary(36)", "mysql")).toBe(true);

    const binaryBytes = parseBinaryCellBytes(hex, "binary(36)", "mysql");
    expect(binaryBytes).not.toBeNull();
    expect(binaryBytes?.length).toBe(36);
    expect(new TextDecoder().decode(binaryBytes!)).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");

    const varbinaryBytes = parseBinaryCellBytes(hex, "varbinary(36)", "mysql");
    expect(varbinaryBytes).not.toBeNull();
    expect(varbinaryBytes?.length).toBe(36);
    expect(new TextDecoder().decode(varbinaryBytes!)).toBe("01a057bf-2bbd-70a6-b3c3-56eb409a0f95");
  });
});
