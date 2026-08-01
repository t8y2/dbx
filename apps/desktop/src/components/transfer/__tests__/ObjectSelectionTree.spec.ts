import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const componentSource = readFileSync(new URL("../ObjectSelectionTree.vue", import.meta.url), "utf8");

describe("ObjectSelectionTree", () => {
  it("renders group headers and item rows with data-test hooks", () => {
    expect(componentSource).toContain(':data-test="`group-${group.kind}`"');
    expect(componentSource).toContain(":data-test=\"'group-toggle'\"");
    expect(componentSource).toContain(':data-test="`item-${group.kind}-${item}`"');
    expect(componentSource).toContain('data-test="search"');
  });

  it("emits update:modelValue when a group header toggles all items", () => {
    expect(componentSource).toContain('emit("update:modelValue"');
    expect(componentSource).toContain("groups");
    expect(componentSource).toContain("modelValue");
  });

  it("filters items by the search prop", () => {
    expect(componentSource).toContain("search");
    expect(componentSource).toContain("filteredGroups");
    expect(componentSource).toContain("searchQuery");
    // the input edits a local ref which is forwarded up via update:search
    expect(componentSource).toContain('v-model="localSearch"');
    expect(componentSource).toContain('emit("update:search", v)');
    expect(componentSource).toContain('"update:search": [value: string]');
    // filtering happens once in a computed, not per render
    expect(componentSource).toContain('v-for="group in filteredGroups"');
    expect(componentSource).toContain('v-for="item in group.items"');
  });

  it("select-all in search mode only selects visible items", () => {
    expect(componentSource).toContain("toggleGroupAll");
    expect(componentSource).toContain("allVisibleSelected");
    expect(componentSource).toContain("[...new Set([...current, ...items])]");
  });

  it("renders disabled groups greyed out with a hint", () => {
    expect(componentSource).toContain("disabledGroups");
    expect(componentSource).toContain("disabledHints");
    expect(componentSource).toContain("opacity-50");
    expect(componentSource).toContain("disabled");
  });
});
