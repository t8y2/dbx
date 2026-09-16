import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../VisibleNacosNamespacesDialog.vue", import.meta.url), "utf8");

describe("VisibleNacosNamespacesDialog", () => {
  it("offers only namespaces readable by the current Nacos connection", () => {
    expect(source).toContain("loadReadableNacosNamespaces(props.connectionId, api)");
    expect(source).toContain("recordPrimaryVisibleObjectNames(props.connectionId, namespaces.value.map(nacosNamespaceValue))");
  });
});
