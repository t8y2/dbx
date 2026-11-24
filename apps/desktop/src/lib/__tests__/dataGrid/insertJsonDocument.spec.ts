import { describe, expect, it } from "vitest";
import { formatInsertJson, parseInsertJsonDocuments, splitInsertJsonDocumentTexts } from "@/lib/dataGrid/insertJsonDocument";

describe("parseInsertJsonDocuments", () => {
  it("accepts a single object", () => {
    expect(parseInsertJsonDocuments('{"a": 1, "b": {"c": [1, 2]}}')).toEqual({ ok: true, documents: [{ a: 1, b: { c: [1, 2] } }] });
  });

  it("accepts an array of objects", () => {
    expect(parseInsertJsonDocuments('[{"a": 1}, {"b": 2}]')).toEqual({ ok: true, documents: [{ a: 1 }, { b: 2 }] });
  });

  it("keeps extended JSON as plain objects", () => {
    expect(parseInsertJsonDocuments('{"_id": {"$oid": "65f000000000000000000000"}}')).toEqual({ ok: true, documents: [{ _id: { $oid: "65f000000000000000000000" } }] });
  });

  it("rejects empty input", () => {
    expect(parseInsertJsonDocuments("   ")).toEqual({ ok: false, error: { kind: "empty" } });
  });

  it("rejects primitives and mixed arrays", () => {
    expect(parseInsertJsonDocuments("42")).toEqual({ ok: false, error: { kind: "not-object" } });
    expect(parseInsertJsonDocuments('[{"a": 1}, 2]')).toEqual({ ok: false, error: { kind: "not-object" } });
    expect(parseInsertJsonDocuments("[]")).toEqual({ ok: false, error: { kind: "empty-array" } });
  });

  it("reports the line of a syntax error", () => {
    const result = parseInsertJsonDocuments('{\n  "a": 1,\n  "b": \n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("syntax");
    if (result.error.kind !== "syntax") return;
    expect(result.error.line).toBe(4);
    expect(result.error.column).toBe(1);
  });

  it("locates a trailing comma and an unquoted key", () => {
    const trailing = parseInsertJsonDocuments('{\n  "a": 1,\n}');
    expect(trailing).toMatchObject({ ok: false, error: { kind: "syntax", line: 3, column: 1 } });
    const unquoted = parseInsertJsonDocuments("{\n  name: 1\n}");
    expect(unquoted).toMatchObject({ ok: false, error: { kind: "syntax", line: 2, column: 3 } });
  });
});

describe("formatInsertJson", () => {
  it("pretty-prints valid JSON", () => {
    expect(formatInsertJson('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it("returns null for invalid JSON", () => {
    expect(formatInsertJson("{")).toBeNull();
  });
});

describe("large numbers", () => {
  it("formats without rounding", () => {
    expect(formatInsertJson('{"n":9007199254740993}')).toBe('{\n  "n": 9007199254740993\n}');
  });

  it("splits an array into exact per-document texts", () => {
    expect(splitInsertJsonDocumentTexts('[{"n":9007199254740993},{"a":"x"}]')).toEqual(['{"n":9007199254740993}', '{"a":"x"}']);
    expect(splitInsertJsonDocumentTexts('{"a":1}')).toEqual(['{"a":1}']);
  });
});
