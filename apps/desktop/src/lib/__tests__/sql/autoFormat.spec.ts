import { describe, expect, it } from "vitest";
import { detectAndFormatStructured, firstNonWhitespaceChar } from "@/lib/sql/autoFormat";

describe("autoFormat", () => {
  describe("firstNonWhitespaceChar", () => {
    it("skips leading whitespace and returns the first significant character", () => {
      expect(firstNonWhitespaceChar(`  \t\n{"a":1}`)).toBe("{");
      expect(firstNonWhitespaceChar("SELECT")).toBe("S");
      expect(firstNonWhitespaceChar("   \n\t")).toBeNull();
    });
  });

  describe("detectAndFormatStructured", () => {
    it("formats a JSON object losslessly with the requested indentation", () => {
      expect(detectAndFormatStructured(`{"a":1,"b":[1,2]}`, { indentSize: 2 })).toEqual({
        kind: "json",
        formatted: `{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}`,
      });
    });

    it("formats a JSON array", () => {
      const result = detectAndFormatStructured(`[1,2]`, { indentSize: 2 });
      expect(result.kind).toBe("json");
      if (result.kind === "json") {
        expect(result.formatted).toContain("\n");
      }
    });

    it("preserves big numeric literals that JSON.parse would round", () => {
      const result = detectAndFormatStructured(`{"big":9007199254740993,"id":1}`, { indentSize: 2 });
      expect(result.kind).toBe("json");
      if (result.kind === "json") {
        expect(result.formatted).toContain("9007199254740993");
      }
    });

    it("routes invalid JSON-looking text to the SQL formatter", () => {
      expect(detectAndFormatStructured(`{a:1}`, { indentSize: 2 })).toEqual({ kind: "sql" });
      expect(detectAndFormatStructured(`{`, { indentSize: 2 })).toEqual({ kind: "sql" });
    });

    it("does not mistake a SQL Server bracket-quoted identifier for JSON", () => {
      expect(detectAndFormatStructured(`[dbo].[orders]`, { indentSize: 2 })).toEqual({ kind: "sql" });
    });

    it("does not mistake a selected SQL comparison fragment for XML", () => {
      expect(detectAndFormatStructured(`< 10`, { indentSize: 2 })).toEqual({ kind: "sql" });
    });

    it("formats XML with nested elements", () => {
      expect(detectAndFormatStructured(`<root><item id="1">value</item><empty/></root>`, { indentSize: 2 })).toEqual({
        kind: "xml",
        formatted: `<root>\n  <item id="1">value</item>\n  <empty/>\n</root>`,
      });
    });

    it("preserves XML mixed content and supports tab indentation", () => {
      expect(detectAndFormatStructured(`<root>Hello <strong>world</strong>!</root>`, { indentSize: 2, useTabs: true })).toEqual({
        kind: "xml",
        formatted: `<root>Hello <strong>world</strong>!</root>`,
      });
    });

    it("rejects invalid XML without handing it to the SQL formatter", () => {
      expect(detectAndFormatStructured(`<root><item></root>`, { indentSize: 2 })).toEqual({ kind: "unsupported", detectedType: "xml" });
    });

    it("routes SQL (and SQL containing an embedded JSON literal) to the SQL formatter", () => {
      expect(detectAndFormatStructured("SELECT * FROM t", { indentSize: 2 })).toEqual({ kind: "sql" });
      expect(detectAndFormatStructured(`SELECT '{"a":1}'::jsonb FROM t`, { indentSize: 2 })).toEqual({ kind: "sql" });
    });

    it("does not treat a leading JSON string literal as JSON (identifier risk)", () => {
      expect(detectAndFormatStructured(`"column"`, { indentSize: 2 })).toEqual({ kind: "sql" });
    });

    it("routes whitespace-only input to the SQL formatter (no-op upstream)", () => {
      expect(detectAndFormatStructured("   \n\t", { indentSize: 2 })).toEqual({ kind: "sql" });
    });
  });
});
