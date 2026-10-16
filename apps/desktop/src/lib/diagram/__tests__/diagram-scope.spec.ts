// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DIAGRAM_SCOPE, diagramScopeStoreIds, disposeDiagramScope, provideDiagramScope, useScopedGraphStore, useScopedLayerStore } from "@/lib/diagram/diagram-scope";

const mountedApps: App[] = [];

/** Mounts a component tree under a diagram scope on the given pinia; returns its scoped stores. */
function mountScoped(scopeId: string, pinia: ReturnType<typeof createPinia>) {
  const handles: { graph: ReturnType<typeof useScopedGraphStore>; layer: ReturnType<typeof useScopedLayerStore> } = {} as never;
  const Child = defineComponent({
    setup() {
      handles.graph = useScopedGraphStore();
      handles.layer = useScopedLayerStore();
      return () => h("div");
    },
  });
  const Root = defineComponent({
    setup() {
      provideDiagramScope(scopeId);
      return () => h(Child);
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(Root);
  mountedApps.push(app);
  app.use(pinia);
  app.mount(container);
  return handles;
}

describe("diagram scope isolation (task 8.1 acceptance)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.textContent = "";
    vi.clearAllMocks();
  });

  it("two simultaneously mounted diagram scopes never share nodes, edges, or layers", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const first = mountScoped("tab-a", pinia);
    const second = mountScoped("tab-b", pinia);
    await nextTick();

    // Independent store instances.
    expect(first.graph).not.toBe(second.graph);
    expect(first.layer).not.toBe(second.layer);

    // Mutating scope A leaves scope B untouched (layers, nodes, undo history).
    const layerA = first.layer.addLayer("Layer A");
    first.layer.addTableToLayer(layerA.id, "orders");
    first.graph.setNodes([{ id: "orders", type: "table", position: { x: 1, y: 2 }, data: { table: { name: "orders" } as never } }]);
    first.graph.updateNodePosition("orders", { x: 9, y: 9 });

    expect(first.layer.layers.map((l) => l.name)).toEqual(["Layer A"]);
    expect(second.layer.layers).toHaveLength(0);
    expect(first.graph.nodes).toHaveLength(1);
    expect(second.graph.nodes).toHaveLength(0);
    expect(first.graph.canUndo).toBe(true);
    expect(second.graph.canUndo).toBe(false);
    expect(second.layer.getLayerColor("orders")).toBe("#9ca3af");

    // And the reverse: scope B mutations do not leak into scope A.
    second.graph.setEdges([{ id: "e1", source: "a", target: "b" }]);
    expect(first.graph.edges).toHaveLength(0);
    expect(second.graph.edges).toHaveLength(1);
  }, 30_000);

  it("disposeDiagramScope drops a scope's stores without touching other scopes", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const first = mountScoped("tab-a", pinia);
    const second = mountScoped("tab-b", pinia);
    await nextTick();
    first.layer.addLayer("keep-me");
    second.layer.addLayer("dispose-me");

    const [graphId, layerId] = diagramScopeStoreIds("tab-b");
    disposeDiagramScope("tab-b", pinia);
    expect(pinia._s.has(graphId)).toBe(false);
    expect(pinia._s.has(layerId)).toBe(false);
    expect(pinia._s.has(diagramScopeStoreIds("tab-a")[0])).toBe(true);

    // A remount of tab-b gets a fresh store; tab-a keeps its layer.
    const remounted = mountScoped("tab-b", pinia);
    await nextTick();
    expect(remounted.layer.layers).toHaveLength(0);
    expect(first.layer.layers.map((l) => l.name)).toEqual(["keep-me"]);
  }, 30_000);

  it("keeps the default scope non-disposable so legacy unscoped call sites stay intact", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const handles = mountScoped(DEFAULT_DIAGRAM_SCOPE, pinia);
    await nextTick();
    handles.layer.addLayer("default-layer");

    disposeDiagramScope(DEFAULT_DIAGRAM_SCOPE, pinia);
    // The default scope survives disposal by design.
    expect(pinia._s.has(diagramScopeStoreIds(DEFAULT_DIAGRAM_SCOPE)[1])).toBe(true);
    expect(handles.layer.layers).toHaveLength(1);
  }, 30_000);
});
