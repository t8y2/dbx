import { describe, expect, it } from "vitest";
import { escapeMarkdownWideCell, formatMarkdownWideTable, MARKDOWN_WIDE_TABLE_MAX_ROWS } from "../markdownWideTable";

describe("escapeMarkdownWideCell", () => {
  it("leaves plain text untouched", () => {
    expect(escapeMarkdownWideCell("ORD-1001")).toBe("ORD-1001");
  });

  it("escapes pipes so they cannot split a column", () => {
    expect(escapeMarkdownWideCell("a|b")).toBe("a\\|b");
  });

  it("turns line breaks into <br>", () => {
    expect(escapeMarkdownWideCell("line1\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownWideCell("line1\r\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownWideCell("line1\rline2")).toBe("line1<br>line2");
  });

  it("renders null and undefined as empty cells", () => {
    expect(escapeMarkdownWideCell(null)).toBe("");
    expect(escapeMarkdownWideCell(undefined)).toBe("");
  });
});

describe("formatMarkdownWideTable", () => {
  const columns = ["order_no", "customer_code", "quantity"];
  const comments = ["Order number", "Customer code", "Quantity"];

  it("transposes a single selected row into three columns", () => {
    const { markdown, rowCount, truncated } = formatMarkdownWideTable(columns, comments, [["ORD-1001", "C-2002", 42]]);
    expect(rowCount).toBe(1);
    expect(truncated).toBe(false);
    expect(markdown).toBe(["| 字段名 | 字段描述 | 行1 |", "|---|---|---|", "| order_no | Order number | ORD-1001 |", "| customer_code | Customer code | C-2002 |", "| quantity | Quantity | 42 |", ""].join("\n"));
  });

  it("keeps one column per selected row and preserves the selection order", () => {
    const { markdown, rowCount } = formatMarkdownWideTable(["id"], ["Primary key"], [[1], [2]]);
    expect(rowCount).toBe(2);
    expect(markdown).toContain("| 字段名 | 字段描述 | 行1 | 行2 |");
    expect(markdown).toContain("| id | Primary key | 1 | 2 |");
  });

  it("caps the data columns at eight rows and reports truncation", () => {
    const rows = Array.from({ length: 10 }, (_, index) => [index + 1]);
    const { markdown, rowCount, truncated } = formatMarkdownWideTable(["id"], [undefined], rows);
    expect(MARKDOWN_WIDE_TABLE_MAX_ROWS).toBe(8);
    expect(rowCount).toBe(8);
    expect(truncated).toBe(true);
    expect(markdown).toContain("| 行8 |");
    expect(markdown).not.toContain("| 行9 |");
    expect(markdown).toContain("| id |  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |");
  });

  it("honours a custom maxRows", () => {
    const { rowCount, truncated } = formatMarkdownWideTable(["id"], [], [[1], [2], [3]], { maxRows: 2 });
    expect(rowCount).toBe(2);
    expect(truncated).toBe(true);
  });

  it("escapes pipes and newlines inside values and headers", () => {
    const { markdown } = formatMarkdownWideTable(["a|b"], ["note\nline"], [["x|y"]]);
    expect(markdown).toContain("| a\\|b | note<br>line | x\\|y |");
  });

  it("renders missing values as empty cells", () => {
    const { markdown } = formatMarkdownWideTable(["a", "b"], [undefined, null], [[1, null]]);
    expect(markdown).toContain("| a |  | 1 |");
    expect(markdown).toContain("| b |  |  |");
  });

  it("supports localized heading labels", () => {
    const { markdown } = formatMarkdownWideTable(["a"], ["c"], [[1]], { fieldNameLabel: "Field", fieldCommentLabel: "Comment", rowLabel: (index) => `Row ${index + 1}` });
    expect(markdown).toContain("| Field | Comment | Row 1 |");
  });
});
