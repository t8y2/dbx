import { describe, expect, it } from "vitest";
import type { ObjectSource } from "@/types/database";
import { oracleTriggerErrorEditorOffset } from "@/lib/table/objectSourceLoad";

function source(text = 'TRIGGER "Owner"."Trigger"\nBEFORE INSERT ON "Parent"."T"\nBEGIN\n  missing_proc;\nEND;\n'): ObjectSource {
  return {
    name: "Trigger",
    schema: "Owner",
    object_type: "TRIGGER",
    source: text,
    trigger: {
      name: "Trigger",
      event: "INSERT",
      timing: "BEFORE",
      oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "oracle", owner: "Owner", name: "Trigger", scope: "TABLE", definition: { origin: "ALL_SOURCE", format: "declaration", complete: true }, reads: { definition: { state: "available" } } },
    },
  };
}
describe("stored trigger diagnostics to the existing editor", () => {
  it.each(["CREATE OR REPLACE ", "-- my unsaved comment\nCREATE OR REPLACE "])("accounts for the actual wrapper and preceding draft text (%s)", (prefix) => {
    const raw = source();
    const editor = prefix + raw.source.trim();
    expect(oracleTriggerErrorEditorOffset(raw, editor, { line: 4, position: 3 })).toBe(editor.indexOf("missing_proc"));
  });
  it("uses dictionary lines and Unicode characters while returning a CodeMirror UTF-16 offset", () => {
    const raw = source(source().source.replace("  missing_proc", "  😀 missing_proc").replaceAll("\n", "\r\n"));
    const editor = "CREATE OR REPLACE " + raw.source.replaceAll("\r\n", "\n").trim();
    expect(oracleTriggerErrorEditorOffset(raw, editor, { line: 4, position: 5 })).toBe(editor.indexOf("missing_proc"));
  });
  it.each(["changed", "duplicate", "commented", "literal", "export", "partial", "wrong-identity"])("does not guess an error location for %s source", (condition) => {
    const raw = source();
    let editor = "CREATE OR REPLACE " + raw.source.trim();
    if (condition === "changed") editor = editor.replace("missing_proc", "corrected_proc");
    if (condition === "duplicate") editor += "\n/* " + raw.source.trim() + " */";
    if (condition === "commented") editor = "/* " + raw.source.trim() + " */";
    if (condition === "literal") editor = "SELECT q'[" + raw.source.trim() + "]' FROM DUAL";
    if (condition === "export") {
      raw.trigger!.oracle_metadata!.definition!.origin = "DBMS_METADATA";
      raw.trigger!.oracle_metadata!.definition!.format = "ddl";
    }
    if (condition === "partial") raw.trigger!.oracle_metadata!.definition!.complete = false;
    if (condition === "wrong-identity") raw.schema = "Other";
    expect(oracleTriggerErrorEditorOffset(raw, editor, { line: 4, position: 3 })).toBeUndefined();
  });
  it.each([
    { line: 0, position: 1 },
    { line: 99, position: 1 },
    { line: 4, position: 999 },
    { line: null, position: 3 },
  ])("does not clamp unavailable coordinates into a different token (%j)", (error) => {
    const raw = source();
    expect(oracleTriggerErrorEditorOffset(raw, "CREATE OR REPLACE " + raw.source, error)).toBeUndefined();
  });
});
