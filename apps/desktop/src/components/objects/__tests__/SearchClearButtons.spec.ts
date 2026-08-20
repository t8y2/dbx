import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");
const databaseBrowserSource = readFileSync(new URL("../DatabaseBrowser.vue", import.meta.url), "utf8");

function functionBody(source: string, name: string): string {
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

describe("database and object browser search clear controls", () => {
  it("renders a clear button with input padding on both search surfaces", () => {
    expect(objectBrowserSource).toContain('class="h-7 pl-8 pr-6 text-xs"');
    expect(objectBrowserSource).toContain(':aria-label="t(\'common.clear\')" @click="clearObjectSearch"');
    expect(objectBrowserSource).toContain('<button v-if="search" type="button"');

    expect(databaseBrowserSource).toContain('class="h-7 pl-8 pr-6 text-xs"');
    expect(databaseBrowserSource).toContain(':aria-label="t(\'common.clear\')" @click="clearDatabaseSearch"');
    expect(databaseBrowserSource).toContain('<button v-if="search" type="button"');
  });

  it("clears and refocuses each search input", () => {
    expect(functionBody(objectBrowserSource, "clearObjectSearch")).toContain('search.value = "";');
    expect(functionBody(objectBrowserSource, "clearObjectSearch")).toContain("getSearchInput()?.focus();");
    expect(functionBody(databaseBrowserSource, "clearDatabaseSearch")).toContain('search.value = "";');
    expect(functionBody(databaseBrowserSource, "clearDatabaseSearch")).toContain("searchInput.value?.$el?.focus();");
  });

  it("keeps the ObjectBrowser keyboard clear path on the shared handler", () => {
    expect(functionBody(objectBrowserSource, "onSearchKeydown")).toContain("clearObjectSearch();");
  });
});
