import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosNamespaceMultiSelect.vue", import.meta.url), "utf8");

describe("NacosNamespaceMultiSelect", () => {
  it("renders selected namespaces as removable tags and keeps the dropdown open for multi-selection", () => {
    expect(source).toContain("data-nacos-namespace-multiselect");
    expect(source).toContain('v-for="value in modelValue"');
    expect(source).toContain('@click.stop="remove(value)"');
    expect(source).toContain('@click="toggle(option.value)"');
    expect(source).toContain("selected.has(option.value)");
    expect(source).toContain("nacos.namespaceSearchPlaceholder");
  });
});
