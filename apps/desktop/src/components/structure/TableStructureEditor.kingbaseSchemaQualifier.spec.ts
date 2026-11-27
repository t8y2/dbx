// @vitest-environment happy-dom

/**
 * #15579 — Kingbase table structure changes lost their schema qualifier, so an
 * ALTER could resolve to a same-named system table. The apply-side gate lives in
 * `applyDdlGenerationPreferences`; the DDL tab runs through
 * `formatStructureDdl` → `applyDdlDisplayPreferences` → the same
 * `applyDdlDatabaseQualifier`, whose `includeDatabaseName === false` branch
 * strips the schema again. The stripping/insertion semantics themselves are
 * covered by `lib/__tests__/table/tableSelectSql` and
 * `lib/sql/__tests__/ddlDisplay`; this pins both gates' wiring so the editable,
 * executable DDL tab cannot regress to a bare table name.
 */

import { describe, expect, it } from "vitest";
import editorSource from "./TableStructureEditor.vue?raw";

function functionSource(name: string): string {
  const start = editorSource.indexOf(`function ${name}(`);
  const end = editorSource.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return editorSource.slice(start, end);
}

describe("table structure editor kingbase schema qualifier (#15579)", () => {
  it("keeps the backend's schema qualifier when applying generated DDL", () => {
    expect(functionSource("applyDdlGenerationPreferences")).toContain('databaseType.value === "kingbase" ? sql : applyDdlDatabaseQualifier(');
  });

  it("does not strip the schema from the DDL tab's display pipeline", () => {
    const source = functionSource("formatStructureDdl");
    expect(source).toContain('includeDatabaseName: databaseType.value === "kingbase" ? true : settingsStore.editorSettings.generateSqlIncludeDatabaseName');
  });
});
