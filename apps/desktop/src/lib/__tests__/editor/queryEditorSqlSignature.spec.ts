import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

const runtimeSource = readFileSync(new URL("../../../components/editor/queryEditorCodeMirrorRuntime.ts", import.meta.url), "utf8");

describe("QueryEditor SQL signature refresh wiring", () => {
  it("reconfigures signature help when the database dialect or driver profile changes", () => {
    expect(runtimeSource).toContain('sqlSignatureComp: import("@codemirror/state").Compartment | null;');
    expect(runtimeSource).toContain("runtime.sqlSignatureComp = new Compartment();");
    expect(queryEditorSource).toContain("initializedRuntime.sqlSignatureComp.of(sqlExtensions.buildSqlSignatureExtension())");

    const watcherStart = queryEditorSource.indexOf("watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect, sqlDriverProfile]");
    const watcherEnd = queryEditorSource.indexOf("\n});", watcherStart);
    const dialectWatcher = queryEditorSource.slice(watcherStart, watcherEnd);

    expect(watcherStart).toBeGreaterThanOrEqual(0);
    expect(watcherEnd).toBeGreaterThan(watcherStart);
    expect(dialectWatcher).toContain("codeMirrorRuntime.sqlSignatureComp.reconfigure(codeMirrorRuntime.buildSqlSignatureExtension())");
  });
});
