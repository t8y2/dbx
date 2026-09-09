import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

function functionBody(name: string, source: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser object-list schema fallback (#8301)", () => {
  it("resolves the listObjects schema through the shared Dameng-aware helper", () => {
    const loadObjects = functionBody("loadObjects", objectBrowserSource);
    expect(loadObjects).toContain("needsSchema.value ? objectListSchemaForConnection(props.connection, selectedSchema.value) : props.database");
    expect(objectBrowserSource).toContain('objectListSchemaForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect"');
  });

  it("routes the schema through the request scope used by listObjects", () => {
    const loadSqlObjectBrowserRows = functionBody("loadSqlObjectBrowserRows", objectBrowserSource);
    expect(loadSqlObjectBrowserRows).toContain("api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema");
    const loadObjects = functionBody("loadObjects", objectBrowserSource);
    expect(loadObjects).toContain("objectBrowserRowsCacheScope(schema)");
  });

  it("keeps the reload chain alive when loadSchemas rejects", () => {
    const reload = functionBody("reload", objectBrowserSource);
    expect(reload).toMatch(/try \{\s*if \(!\(await loadSchemas\(epoch\)\)\) return;\s*\} catch/);
    const catchClause = reload.slice(reload.indexOf("} catch"));
    // The failure path must not clear the selection (props.schema / current value)
    // and must still load objects — Dameng then falls back to the username.
    expect(catchClause).not.toContain("selectedSchema.value =");
    expect(catchClause).toContain("console.warn");
    expect(reload.lastIndexOf("await loadObjects")).toBeGreaterThan(reload.indexOf("} catch"));
  });

  it("leaves the selected schema untouched when listSchemas itself rejects", () => {
    const loadSchemas = functionBody("loadSchemas", objectBrowserSource);
    // Every selectedSchema assignment in the try block sits behind the awaited
    // listSchemas call, so a rejection keeps the current selection intact.
    const tryStart = loadSchemas.indexOf("try {");
    const apiCall = loadSchemas.indexOf("await api.listSchemas", tryStart);
    const firstAssignment = loadSchemas.indexOf("selectedSchema.value =", apiCall);
    expect(apiCall).toBeGreaterThan(tryStart);
    expect(firstAssignment).toBeGreaterThan(apiCall);
  });
});
