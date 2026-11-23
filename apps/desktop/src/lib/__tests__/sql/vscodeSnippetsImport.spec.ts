import { describe, expect, it } from "vitest";
import { MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES, mergeImportedVscodeSnippets, parseVscodeSnippetsFile, serializeVscodeSnippetsFile, type VscodeSnippetEntry } from "@/lib/sql/vscodeSnippetsImport";
import type { SqlSnippet } from "@/types/database";

function existingSnippet(prefix: string, overrides: Partial<SqlSnippet> = {}): SqlSnippet {
  return { id: `existing-${prefix}`, label: prefix, prefix, body: `-- ${prefix}`, enabled: true, ...overrides };
}

function entry(overrides: Partial<VscodeSnippetEntry> = {}): VscodeSnippetEntry {
  return { name: "Imported", prefix: "imp", body: "SELECT 1", ...overrides };
}

describe("parseVscodeSnippetsFile", () => {
  it("parses string bodies and prefixes and ignores description and scope", () => {
    const result = parseVscodeSnippetsFile(
      JSON.stringify({
        "Select rows": { prefix: "selr", body: "SELECT * FROM ${1:table}", description: "ignored", scope: "sql,plsql" },
      }),
    );

    expect(result).toEqual({ ok: true, value: [{ name: "Select rows", prefix: "selr", body: "SELECT * FROM ${1:table}" }] });
  });

  it("joins array bodies with newlines", () => {
    const result = parseVscodeSnippetsFile(JSON.stringify({ Multi: { prefix: "multi", body: ["SELECT *", "FROM t"] } }));

    expect(result).toEqual({ ok: true, value: [{ name: "Multi", prefix: "multi", body: "SELECT *\nFROM t" }] });
  });

  it("takes the first non-empty element of array prefixes", () => {
    const result = parseVscodeSnippetsFile(JSON.stringify({ Snip: { prefix: [" ", "first", "second"], body: "SELECT 1" } }));

    expect(result).toEqual({ ok: true, value: [{ name: "Snip", prefix: "first", body: "SELECT 1" }] });
  });

  it("slugs the name when the prefix is missing and skips unsluggable names", () => {
    const result = parseVscodeSnippetsFile(JSON.stringify({ "Select rows": { body: "SELECT 1" }, "###": { body: "SELECT 2" } }));

    expect(result).toEqual({ ok: true, value: [{ name: "Select rows", prefix: "select-rows", body: "SELECT 1" }] });
  });

  it("skips entries without a usable body or entry object", () => {
    const result = parseVscodeSnippetsFile(
      JSON.stringify({
        ok: { prefix: "ok", body: "SELECT 1" },
        emptyBody: { prefix: "eb", body: "" },
        numberBody: { prefix: "nb", body: 42 },
        nullBody: { prefix: "nl", body: null },
        notAnObject: "nope",
      }),
    );

    expect(result).toEqual({ ok: true, value: [{ name: "ok", prefix: "ok", body: "SELECT 1" }] });
  });

  it("rejects invalid JSON with invalid-json", () => {
    expect(parseVscodeSnippetsFile("{nope")).toEqual({ ok: false, error: { code: "invalid-json" } });
  });

  it.each([
    ["array root", "[]"],
    ["string root", '"snippets"'],
    ["null root", "null"],
  ])("rejects %s with invalid-structure", (_name, text) => {
    expect(parseVscodeSnippetsFile(text)).toEqual({ ok: false, error: { code: "invalid-structure" } });
  });

  it("rejects empty and fully-invalid maps with no-valid-snippets", () => {
    expect(parseVscodeSnippetsFile("{}")).toEqual({ ok: false, error: { code: "no-valid-snippets" } });
    expect(parseVscodeSnippetsFile(JSON.stringify({ bad: { prefix: "b" } }))).toEqual({ ok: false, error: { code: "no-valid-snippets" } });
  });

  it("rejects oversized files with too-large", () => {
    expect(parseVscodeSnippetsFile("x".repeat(MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES + 1))).toEqual({ ok: false, error: { code: "too-large" } });
  });
});

describe("mergeImportedVscodeSnippets", () => {
  it("appends entries verbatim when no prefix collides", () => {
    const existing = [existingSnippet("sel")];

    const merged = mergeImportedVscodeSnippets(existing, [entry()]);

    expect(merged.importedCount).toBe(1);
    expect(merged.renamedCount).toBe(0);
    expect(merged.snippets).toHaveLength(2);
    expect(merged.snippets[0]).toEqual(existing[0]);
    expect(merged.snippets[1]).toMatchObject({ label: "Imported", prefix: "imp", body: "SELECT 1", enabled: true });
    expect(merged.snippets[1].id).toBeTruthy();
    // existing items are copied, not mutated or shared
    expect(merged.snippets[0]).not.toBe(existing[0]);
  });

  it("gives colliding prefixes the smallest free numeric suffix", () => {
    const existing = [existingSnippet("imp"), existingSnippet("imp-2")];

    const merged = mergeImportedVscodeSnippets(existing, [entry()]);

    expect(merged.renamedCount).toBe(1);
    expect(merged.snippets.at(-1)?.prefix).toBe("imp-3");
  });

  it("renames batch-internal duplicates and avoids suffix collisions", () => {
    const existing = [existingSnippet("dup"), existingSnippet("dup-2")];

    const merged = mergeImportedVscodeSnippets(existing, [entry({ prefix: "dup" }), entry({ name: "Second", prefix: "dup" })]);

    expect(merged.renamedCount).toBe(2);
    expect(merged.snippets.slice(2).map((snippet) => snippet.prefix)).toEqual(["dup-3", "dup-4"]);
  });

  it("allows labels to duplicate existing ones", () => {
    const existing = [existingSnippet("sel", { label: "Same label" })];

    const merged = mergeImportedVscodeSnippets(existing, [entry({ name: "Same label" })]);

    expect(merged.renamedCount).toBe(0);
    expect(merged.snippets.map((snippet) => snippet.label)).toEqual(["Same label", "Same label"]);
  });

  it("supports importing into an empty list", () => {
    const merged = mergeImportedVscodeSnippets([], [entry(), entry({ name: "Other", prefix: "other", body: "SELECT 2" })]);

    expect(merged).toMatchObject({ importedCount: 2, renamedCount: 0 });
    expect(merged.snippets.map((snippet) => snippet.prefix)).toEqual(["imp", "other"]);
    expect(new Set(merged.snippets.map((snippet) => snippet.id)).size).toBe(2);
  });
});

describe("serializeVscodeSnippetsFile", () => {
  it("round-trips snippets through parseVscodeSnippetsFile, including disabled ones and placeholders", () => {
    const text = serializeVscodeSnippetsFile([existingSnippet("sel"), existingSnippet("ins", { label: "Insert row", body: "INSERT INTO ${1:table}\nVALUES (${2:values});", enabled: false })]);

    expect(parseVscodeSnippetsFile(text)).toEqual({
      ok: true,
      value: [
        { name: "sel", prefix: "sel", body: "-- sel" },
        { name: "Insert row", prefix: "ins", body: "INSERT INTO ${1:table}\nVALUES (${2:values});" },
      ],
    });
  });

  it("suffixes duplicate labels so every map key stays unique", () => {
    const text = serializeVscodeSnippetsFile([existingSnippet("a", { label: "Same" }), existingSnippet("b", { label: "Same" }), existingSnippet("c", { label: "Same-2" })]);

    expect(Object.keys(JSON.parse(text))).toEqual(["Same", "Same-2", "Same-2-2"]);
  });

  it("falls back to the prefix for blank labels and ends with a newline", () => {
    const text = serializeVscodeSnippetsFile([existingSnippet("sel", { label: "   " })]);

    expect(text).toBe(`${JSON.stringify({ sel: { prefix: "sel", body: "-- sel" } }, null, 2)}\n`);
  });
});
