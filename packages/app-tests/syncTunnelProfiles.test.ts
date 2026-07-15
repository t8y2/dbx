import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

function functionBody(source: string, name: string): string {
  const signature = `async function ${name}(`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `Could not find function ${name}`);
  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `Could not find body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse body for ${name}`);
}

test("sync downloads refresh shared tunnel profiles", () => {
  const source = readFileSync("apps/desktop/src/components/editor/EditorSettingsDialog.vue", "utf8");

  for (const functionName of ["downloadSnippetSnapshot", "downloadWebDavSnapshot"]) {
    const body = functionBody(source, functionName);
    assert.match(body, /await tunnelProfileStore\.refresh\(\)/, `${functionName} should refresh downloaded tunnel profiles`);
  }
});
