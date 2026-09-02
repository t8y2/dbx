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

describe("ObjectBrowser viewport persistence", () => {
  it("flushes the latest scroll position before generating SQL", () => {
    const body = functionBody("openNewQuery");
    const flushIndex = body.indexOf("flushObjectBrowserViewport();");
    const createTabIndex = body.indexOf("queryStore.createTab");

    expect(flushIndex).toBeGreaterThanOrEqual(0);
    expect(createTabIndex).toBeGreaterThan(flushIndex);
  });
});
