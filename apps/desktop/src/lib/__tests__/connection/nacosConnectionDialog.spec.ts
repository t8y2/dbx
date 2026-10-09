import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("Nacos connection dialog layout", () => {
  it("uses namespaces when scoping Nacos production safeguards", () => {
    expect(source).toContain('form.value.db_type === "nacos"');
    expect(source).toContain("production.allNamespaces");
    expect(source).toContain("production.namespacePickerTitle");
    expect(source).toContain("loadReadableNacosNamespaces(connectionId, api)");
    expect(source).toContain("nacosNamespaceIdentity(name)");
  });
});
