import { describe, expect, it } from "vitest";
import { formatGridSnapshotCell, gridSnapshotMetadataControlState, renderGridSnapshotHtml } from "@/lib/gridSnapshot/gridSnapshot";

describe("grid snapshot rendering", () => {
  it("enables field metadata only when field names are visible", () => {
    expect(gridSnapshotMetadataControlState({ showFieldNames: true, hasColumnTypes: true, hasColumnDetails: true })).toEqual({ columnTypesDisabled: false, columnDetailsDisabled: false });
    expect(gridSnapshotMetadataControlState({ showFieldNames: false, hasColumnTypes: true, hasColumnDetails: true })).toEqual({ columnTypesDisabled: true, columnDetailsDisabled: true });
    expect(gridSnapshotMetadataControlState({ showFieldNames: true, hasColumnTypes: false, hasColumnDetails: false })).toEqual({ columnTypesDisabled: true, columnDetailsDisabled: true });
  });

  it("formats primitive values and NULL consistently", () => {
    expect(formatGridSnapshotCell(null)).toBe("NULL");
    expect(formatGridSnapshotCell(true)).toBe("true");
    expect(formatGridSnapshotCell(42)).toBe("42");
  });

  it("renders an escaped, self-contained table with optional headers and row numbers", () => {
    const html = renderGridSnapshotHtml(
      {
        columns: ["id", "name"],
        columnTypes: ["integer", "varchar"],
        columnDetails: ["Primary key", "Display name"],
        rows: [
          [1, "<Ada>"],
          [2, null],
        ],
        title: "Users",
      },
      { appearance: "light", showTrafficLights: false, showFieldNames: true, showRowNumbers: true },
    );
    expect(html).toContain("dbx-grid-snapshot");
    expect(html).toContain("&lt;Ada&gt;");
    expect(html).toContain(">NULL</td>");
    expect(html).toContain(">#</th>");
    expect(html).toContain(">1</td>");
    expect(html).not.toContain("#ff5f57");
    expect(html).not.toContain("integer");
    expect(html).not.toContain("Primary key");
    expect(html).toContain("width: max-content");
    expect(html).toContain("border-collapse: separate");
    expect(html).not.toMatch(/<td[^>]*dbx-grid-snapshot__cell--wrapped/);
  });

  it("optionally renders column types and details below field names", () => {
    const html = renderGridSnapshotHtml(
      {
        columns: ["id"],
        columnTypes: ["integer"],
        columnDetails: ["Primary key"],
        rows: [[1]],
      },
      { appearance: "dark", showColumnTypes: true, showColumnDetails: true, wrapCells: true },
    );
    expect(html).toContain("dbx-grid-snapshot__column-meta");
    expect(html).toContain(">integer</span>");
    expect(html).toContain(">Primary key</span>");
    expect(html).toMatch(/<td[^>]*dbx-grid-snapshot__cell--wrapped/);
  });

  it("can render a compact data-only view", () => {
    const html = renderGridSnapshotHtml({ columns: ["value"], rows: [["x"]] }, { appearance: "dark", showFieldNames: false, showRowNumbers: false, compact: true });
    expect(html).not.toContain("<thead>");
    expect(html).not.toMatch(/<td[^>]*dbx-grid-snapshot__cell--row-number/);
    expect(html).toContain("font-size:12px");
  });

  it("transposes fields into rows while keeping field metadata attached", () => {
    const html = renderGridSnapshotHtml(
      {
        columns: ["id", "name"],
        columnTypes: ["integer", "varchar"],
        columnDetails: ["Primary key", "Display name"],
        rows: [
          [1, "Ada"],
          [2, "Bob"],
        ],
      },
      { appearance: "light", transpose: true, fieldNameLabel: "Field Names", showColumnTypes: true, showColumnDetails: true },
    );
    expect(html).toContain(">Field Names</span>");
    expect(html).toContain(">#1</span>");
    expect(html).toContain(">#2</span>");
    expect(html).toContain(">id</span>");
    expect(html).toContain(">integer</span>");
    expect(html).toContain(">Primary key</span>");
    expect(html).toContain(">Ada</td>");
    expect(html).toContain(">Bob</td>");
  });

  it("hides the field-name placement while preserving transposed row identifiers", () => {
    const source = {
      columns: ["id", "name"],
      columnTypes: ["integer", "varchar"],
      columnDetails: ["Primary key", "Display name"],
      rows: [
        [1, "Ada"],
        [2, "Bob"],
      ],
    };
    const transposed = renderGridSnapshotHtml(source, { appearance: "light", transpose: true, fieldNameLabel: "Field Names", showFieldNames: false, showColumnTypes: true, showColumnDetails: true, showRowNumbers: false });
    expect(transposed).toContain("<thead>");
    expect(transposed).toContain(">#1</span>");
    expect(transposed).toContain(">#2</span>");
    expect(transposed).not.toContain("Field Names");
    expect(transposed).not.toContain(">id</span>");
    expect(transposed).not.toContain(">name</span>");
    expect(transposed).not.toContain("integer");
    expect(transposed).not.toContain("Primary key");
    expect(transposed).toContain(">Ada</td>");
    expect(transposed).toContain(">Bob</td>");

    const regular = renderGridSnapshotHtml(source, { appearance: "light", showFieldNames: false, showColumnTypes: true, showColumnDetails: true });
    expect(regular).not.toContain("<thead>");
    expect(regular).not.toContain("integer");
    expect(regular).not.toContain("Primary key");
  });
});
