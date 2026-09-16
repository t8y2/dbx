import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(fileURLToPath(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url)), "utf8");

function functionSource(name: string): string {
  const start = runtimeSource.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = runtimeSource.indexOf("\nfunction ", start + 1);
  return runtimeSource.slice(start, next === -1 ? undefined : next);
}

describe("SidebarTreeRuntimeHost createView identifier quoting (#9099)", () => {
  it("forwards the generate-SQL settings to qualifiedTableName", () => {
    const createView = functionSource("createView");
    const callStart = createView.indexOf("qualifiedTableName({");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = createView.indexOf("});", callStart);
    const call = createView.slice(callStart, callEnd);

    // Turning off the quote toggle must reach qualifiedTableName; otherwise it
    // unconditionally quotes the schema/view name regardless of the setting.
    expect(call).toContain("quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers");
    expect(call).toContain("includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName");
  });
});
