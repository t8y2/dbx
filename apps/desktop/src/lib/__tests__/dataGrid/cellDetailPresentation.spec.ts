import { describe, expect, it } from "vitest";
import { canPreviewCellGeometry, compactJsonText, formatJsonText, isGeometryColumnType, looksLikeJsonContainerText, valueEditorActions } from "@/lib/dataGrid/cellDetailPresentation";

describe("cellDetailPresentation", () => {
  it("offers compact JSON beside format JSON for editable JSON values", () => {
    expect(valueEditorActions({ canSetNull: true, canFormatJson: true })).toEqual(["formatJson", "compactJson", "setNull", "restoreOriginal"]);
    expect(valueEditorActions({ canSetNull: false, canFormatJson: false })).toEqual(["restoreOriginal"]);
    expect(compactJsonText('{\n  "name": "DBX",\n  "enabled": true\n}')).toBe('{"name":"DBX","enabled":true}');
  });

  it("formats serialized JSON strings into pretty-printed JSON (issue #11636)", () => {
    const serialized = '"{\\"abc\\":\\"\\"}"';
    expect(looksLikeJsonContainerText(serialized)).toBe(true);
    expect(formatJsonText(serialized)).toBe('{\n  "abc": ""\n}');

    // Scalar string in quotes is not treated as a container
    expect(looksLikeJsonContainerText('"hello"')).toBe(false);
  });

  it("detects geometry values for preview from column type or WKT content", () => {
    expect(isGeometryColumnType("geometry")).toBe(true);
    expect(isGeometryColumnType("GEOGRAPHY")).toBe(true);
    expect(isGeometryColumnType("geometry(Point, 4326)")).toBe(true);
    expect(isGeometryColumnType("text")).toBe(false);

    // Geometry column with valid WKT
    expect(canPreviewCellGeometry("POINT(1 2)", "geometry")).toBe(true);
    // Text column with WKT string (e.g. PostgreSQL ST_AsText or raw WKT)
    expect(canPreviewCellGeometry("POINT(116.397 39.908)", "text")).toBe(true);
    expect(canPreviewCellGeometry("POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))", "varchar")).toBe(true);
    expect(canPreviewCellGeometry("SRID=4326;POINT(1 2)", "text")).toBe(true);
    expect(canPreviewCellGeometry("MULTIPOLYGON EMPTY", "text")).toBe(true);
    expect(canPreviewCellGeometry("LINESTRING Z (1 2 3, 4 5 6)", "text")).toBe(true);
    expect(canPreviewCellGeometry("point(1 2)", "text")).toBe(true);

    // Non-geometry strings or null
    expect(canPreviewCellGeometry("just a normal string", "text")).toBe(false);
    expect(canPreviewCellGeometry(null, "geometry")).toBe(false);
    expect(canPreviewCellGeometry(undefined, "text")).toBe(false);
    expect(canPreviewCellGeometry(123, "text")).toBe(false);

    // Ordinary text that the lenient WKT parser alone would accept
    expect(canPreviewCellGeometry("No records (0)", "text")).toBe(false);
    expect(canPreviewCellGeometry("FY report (2024)", "text")).toBe(false);
    expect(canPreviewCellGeometry("result is empty", "text")).toBe(false);
    expect(canPreviewCellGeometry("empty", "text")).toBe(false);
    expect(canPreviewCellGeometry("Meeting notes (see attached 3 items)", "text")).toBe(false);
  });
});
