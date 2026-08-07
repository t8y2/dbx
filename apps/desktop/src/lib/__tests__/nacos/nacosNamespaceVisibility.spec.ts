import { describe, expect, it } from "vitest";
import { filterNacosNamespacesForSidebar, normalizeNacosNamespaceSelection, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";

const namespaces = [
  { namespace: "", namespaceShowName: "public" },
  { namespace: "dev", namespaceShowName: "开发" },
  { namespace: "prod", namespaceShowName: "生产" },
];

describe("filterNacosNamespacesForSidebar", () => {
  it("keeps all namespaces when no visibility filter is configured", () => {
    expect(filterNacosNamespacesForSidebar(namespaces, undefined)).toEqual(namespaces);
  });

  it("filters by namespace id and preserves the public empty identifier", () => {
    expect(filterNacosNamespacesForSidebar(namespaces, ["", "prod"])).toEqual([namespaces[0], namespaces[2]]);
  });

  it("matches a legacy empty public selection with a concrete public namespace", () => {
    const v3Namespaces = [{ namespace: "public", namespaceShowName: "public" }, namespaces[2]];
    expect(filterNacosNamespacesForSidebar(v3Namespaces, ["", "prod"])).toEqual(v3Namespaces);
    expect(normalizeNacosNamespaceSelection([""], v3Namespaces)).toEqual(["public"]);
  });

  it("preserves the endpoint-specific public ID when normalizing selections", () => {
    expect(normalizeNacosNamespaceSelection(["public"], namespaces)).toEqual([""]);
  });

  it("keeps only the concrete public namespace when both legacy forms are returned", () => {
    const duplicatePublic = [namespaces[0], { namespace: "public", namespaceShowName: "public" }, namespaces[1]];
    expect(normalizeNacosNamespacesForDisplay(duplicatePublic)).toEqual([duplicatePublic[1], duplicatePublic[2]]);
  });
});
