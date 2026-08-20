import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

function functionBody(name: string): string {
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

describe("ObjectBrowser table metadata refresh", () => {
  it("refreshes the object list and the open table-info tab from the toolbar", () => {
    const refresh = functionBody("refresh");

    expect(refresh).toContain("void reload();");
    expect(refresh).toContain("void refreshActiveTableInfo();");
    expect(source).toContain('@click="refresh"');
  });

  it("invalidates stale requests and reloads only the active metadata surface", () => {
    const refreshTableInfo = functionBody("refreshActiveTableInfo");

    expect(refreshTableInfo).toContain('sidePanelMode.value !== "table-info" || !sidePanelRow.value');
    expect(refreshTableInfo).toContain("sidePanelGuard.bump();");
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "ddl"[\s\S]*?tableDdlContent\.value = "";[\s\S]*?await fetchTableDdl\(true\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "columns"[\s\S]*?tableColumns\.value = \[\];[\s\S]*?await fetchTableColumns\(true\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "indexes"[\s\S]*?tableIndexes\.value = \[\];[\s\S]*?await fetchTableIndexes\(true\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "foreignKeys"[\s\S]*?tableForeignKeys\.value = \[\];[\s\S]*?await fetchTableForeignKeys\(true\);/);
    expect(refreshTableInfo).toMatch(/tableInfoTab\.value === "triggers"[\s\S]*?tableTriggers\.value = \[\];[\s\S]*?await fetchTableTriggers\(true\);/);
  });

  it("routes table-info metadata through the object caches", () => {
    expect(source).toContain('from "@/lib/metadata/objectDdlCache"');
    expect(source).toContain('from "@/lib/metadata/objectMetadataCache"');
    expect(functionBody("fetchTableDdl")).toContain("loadObjectDdl(");
    for (const name of ["fetchTableColumns", "fetchTableIndexes", "fetchTableForeignKeys", "fetchTableTriggers"]) {
      expect(functionBody(name)).toContain("loadObjectMetadataFacet(");
      expect(functionBody(name)).not.toContain(".value.length > 0");
    }
  });

  it("keeps automatic object reloads free of extra metadata requests", () => {
    expect(functionBody("reload")).not.toContain("refreshActiveTableInfo");
  });

  it("leaves a failed facet eligible for retry", () => {
    for (const name of ["fetchTableDdl", "fetchTableColumns", "fetchTableIndexes", "fetchTableForeignKeys", "fetchTableTriggers"]) {
      const body = functionBody(name);
      expect(body).toContain("let loadedSuccessfully = false;");
      expect(body).toMatch(/loadedSuccessfully = true;/);
      expect(body).toMatch(/Loaded\.value = loadedSuccessfully;/);
    }
  });
});
