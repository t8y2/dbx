import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #8236: switching away from the "Browse Objects" tab and back reset
// the keyword search filter, because ObjectBrowser has no <KeepAlive> around
// it (ContentArea renders it inside a plain v-else-if chain) and its `search`
// ref was always seeded to "". The fix threads the value through
// activeTab.objectBrowser.searchQuery, mirroring the existing viewport
// persistence path.

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../layout/ContentArea.vue", import.meta.url), "utf8");
const querySurfacesSource = readFileSync(new URL("../../layout/querySurfaces.ts", import.meta.url), "utf8");
const contentSurfaceEventsSource = readFileSync(new URL("../../../lib/tabs/contentSurfaceEvents.ts", import.meta.url), "utf8");
const queryStoreSource = readFileSync(new URL("../../../stores/queryStore.ts", import.meta.url), "utf8");
const databaseTypesSource = readFileSync(new URL("../../../types/database.ts", import.meta.url), "utf8");

describe("ObjectBrowser keyword search survives tab switches", () => {
  it("seeds the local search ref from a persisted initial value instead of always starting empty", () => {
    expect(objectBrowserSource).toContain("initialSearchQuery?: string;");
    expect(objectBrowserSource).toContain('const search = ref(props.initialSearchQuery ?? "");');
  });

  it("emits searchChange whenever the keyword changes, so the parent can persist it", () => {
    expect(objectBrowserSource).toContain("searchChange: [query: string];");
    expect(objectBrowserSource).toMatch(/watch\(search, \(value\) => \{\s*scrollObjectsToTop\(\);\s*emit\("searchChange", value\);\s*\}\);/);
  });

  it("ContentArea binds the persisted search query as a prop and forwards the change event", () => {
    expect(contentAreaSource).toContain(':initial-search-query="activeTab.objectBrowser?.searchQuery"');
    expect(contentAreaSource).toContain("@search-change=\"emit('objectBrowserSearchChange', activeTab.id, $event)\"");
  });

  it("the surface event contract and forwarding list both know about objectBrowserSearchChange", () => {
    expect(querySurfacesSource).toContain("objectBrowserSearchChange: [tabId: string, query: string];");
    expect(contentSurfaceEventsSource).toContain('"objectBrowserSearchChange",');
  });

  it("queryStore persists the search query onto the tab's objectBrowser state", () => {
    expect(queryStoreSource).toContain("function updateObjectBrowserSearch(id: string, query: string)");
    expect(queryStoreSource).toContain("tab.objectBrowser = { ...tab.objectBrowser, searchQuery: query };");
    expect(queryStoreSource).toContain("updateObjectBrowserSearch,");
  });

  it("the tab type declares searchQuery on objectBrowser state", () => {
    expect(databaseTypesSource).toMatch(/objectBrowser\?:\s*\{[^}]*searchQuery\?:\s*string;/s);
  });
});
