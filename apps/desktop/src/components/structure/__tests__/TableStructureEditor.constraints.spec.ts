import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../TableStructureEditor.vue", import.meta.url), "utf8");

describe("TableStructureEditor constraints", () => {
  it("renders complete check expressions instead of truncating them", () => {
    expect(source).toContain('class="mt-1 whitespace-pre-wrap break-words font-mono text-muted-foreground">{{ constraint.definition }}');
    expect(source).not.toContain('class="mt-1 truncate font-mono text-muted-foreground">{{ constraint.definition }}');
  });

  it("isolates secondary metadata failures to their owning tabs", () => {
    expect(source).toContain("Promise.allSettled([indexesPromise, foreignKeysPromise, constraintsPromise, triggersPromise])");
    expect(source).toContain("secondaryMetadataErrors.value[facet] = result.reason?.message || String(result.reason)");
    expect(source).toContain('v-else-if="secondaryMetadataErrors.constraints"');
    expect(source).not.toContain("errorMessage.value = reason?.message || String(reason)");
  });
});
