import { describe, expect, it, vi } from "vitest";
import { filterNacosNamespacesForSidebar, filterReadableNacosNamespaces, isNacosNamespaceAccessDenied, normalizeNacosNamespaceSelection, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import { nacosVisibleNamespaceSummary } from "@/lib/sidebar/sidebarVisibleFilterSummary";

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

  it("counts a legacy public selection as visible for a Nacos 3 endpoint", () => {
    expect(nacosVisibleNamespaceSummary({ visible_databases: ["", "prod"] }, ["public", "dev", "prod"])).toEqual({
      mode: "namespace",
      isActive: true,
      selected: 2,
      total: 3,
    });
  });
});

describe("filterReadableNacosNamespaces", () => {
  it("removes namespaces that explicitly reject config reads with 403", async () => {
    const denied = new Error('NACOS_ERROR[authFailed]: Nacos admin /v1/cs/configs returned 403 Forbidden: {"message":"authorization failed!"}');
    const probe = vi.fn(async (namespace: string) => {
      if (namespace !== "dev") throw denied;
    });

    await expect(filterReadableNacosNamespaces(namespaces, probe)).resolves.toEqual([namespaces[1]]);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("does not hide authentication, transport, or unexpected failures", async () => {
    const unauthorized = new Error("NACOS_ERROR[authFailed]: returned 401 Unauthorized");
    await expect(filterReadableNacosNamespaces(namespaces, async () => Promise.reject(unauthorized))).rejects.toBe(unauthorized);
    expect(isNacosNamespaceAccessDenied(unauthorized)).toBe(false);
    expect(isNacosNamespaceAccessDenied({ detail: "NACOS_ERROR[authFailed]: 403 Forbidden" })).toBe(true);
  });

  it("limits concurrent probes while preserving namespace order", async () => {
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });

    await expect(filterReadableNacosNamespaces(namespaces, probe, 2)).resolves.toEqual(namespaces);
    expect(peak).toBe(2);
  });
});
