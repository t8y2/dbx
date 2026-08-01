import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function extractFunction(name: string): string {
  const start = queryEditorSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing QueryEditor function: ${name}`);
  const bodyStart = queryEditorSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < queryEditorSource.length; index++) {
    const character = queryEditorSource[index];
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return queryEditorSource.slice(start, index + 1);
  }
  throw new Error(`Unterminated QueryEditor function: ${name}`);
}

describe("QueryEditor database name completion wiring", () => {
  it("uses the shared capability for local lookup, background refresh, and async loading", () => {
    expect(extractFunction("localCompletionDatabaseNames")).toContain("supportsDatabaseNameCompletion(props.databaseType)");
    expect(extractFunction("scheduleCompletionMetadataRefresh")).toMatch(/supportsDatabaseNameCompletion\(props\.databaseType\)[\s\S]*?refreshCompletionDatabases\(connectionId\)/);
    expect(extractFunction("performAsyncCompletionWithResult")).toMatch(/supportsDatabaseNameCompletion\(props\.databaseType\)[\s\S]*?listCompletionDatabases\(props\.connectionId!\)/);
  });

  it("does not reuse cached tables while completing schemas inside a database", () => {
    expect(extractFunction("buildLocalSqlCompletionResult")).toMatch(/const tables = schemaLookupDatabase\s*\?\s*\[\]/);
    expect(extractFunction("performAsyncCompletionWithResult")).toMatch(/let tables = schemaLookupDatabase\s*\?\s*\[\]/);
  });

  it("limits database and schema disambiguation to engines with both capabilities", () => {
    const guard = extractFunction("mayCompleteDatabaseSchemaQualifier");

    expect(guard).toContain("supportsDatabaseNameCompletion(props.databaseType)");
    expect(guard).toContain("supportsDatabaseSchemaQualifierCompletion()");
  });

  it("uses the resolved database scope for routine completion and isolates the editor cache", () => {
    expect(extractFunction("routineCompletionTargetForContext")).toContain("currentDatabase: scope.database");
    expect(extractFunction("routineCompletionTargetForContext")).toContain("supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion()");
    expect(extractFunction("lookupLocalCompletionObjectsForContext")).toContain("target.database");
    expect(extractFunction("listCompletionObjectsForContext")).toContain("target.database");
    expect(extractFunction("routineCompletionScopeForContext")).toContain("database: target.database");
    expect(extractFunction("completionObjectScopeKey")).toContain("scope.database");
    expect(extractFunction("completionObjectScopeKey")).toContain("scope.schema");
    expect(queryEditorSource).toContain("cachedCompletionObjectsByScope");
  });

  it("loads SQL Server capability metadata before offering or applying USE completion", () => {
    const provider = extractFunction("provideSqlCompletions");

    expect(provider).toContain("getSqlServerCompletionContext");
    expect(provider).toContain("supports_session_database_switch");
    expect(provider).toContain("useDatabaseDefaultSchema");
  });
});
