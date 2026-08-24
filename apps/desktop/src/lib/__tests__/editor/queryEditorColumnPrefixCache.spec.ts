import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor column prefix cache", () => {
  it("hydrates qualified completions from the persistent prefix cache", () => {
    const prefixLookups = queryEditorSource.match(/lookupLocalCompletionColumnsByPrefix/g) ?? [];

    expect(prefixLookups.length).toBeGreaterThanOrEqual(2);
    expect(queryEditorSource).toContain("completionColumnRequestContext(reference)");
  });
});
