import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor SQL signature refresh wiring", () => {
  it("reconfigures signature help when the database dialect changes", () => {
    expect(queryEditorSource).toContain('let sqlSignatureComp: import("@codemirror/state").Compartment | null = null;');
    expect(queryEditorSource).toContain("sqlSignatureComp.of(buildSqlSignatureExtension())");

    const watcherStart = queryEditorSource.indexOf("watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect]");
    const watcherEnd = queryEditorSource.indexOf("\n});", watcherStart);
    const dialectWatcher = queryEditorSource.slice(watcherStart, watcherEnd);

    expect(watcherStart).toBeGreaterThanOrEqual(0);
    expect(watcherEnd).toBeGreaterThan(watcherStart);
    expect(dialectWatcher).toContain("sqlSignatureComp.reconfigure(buildSqlSignatureExtension())");
  });
});
