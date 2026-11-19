// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import type { Core, LayoutOptions } from "cytoscape";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, GraphProperty, GraphResult } from "@/lib/graph/graphResult";

const renderer = vi.hoisted(() => ({ instances: [] as Core[], layouts: [] as (LayoutOptions & { fixedNodeConstraint?: { nodeId: string }[] })[] }));
vi.mock("cytoscape", async (importOriginal) => {
  const { default: cytoscape } = await importOriginal<typeof import("cytoscape")>();
  const factory = Object.assign(
    (options: Parameters<typeof cytoscape>[0]) => {
      const core = cytoscape({ ...options, container: undefined, headless: true, styleEnabled: true });
      vi.spyOn(core, "layout").mockImplementation((layout) => {
        const constraints = layout as (typeof renderer.layouts)[number];
        renderer.layouts.push(constraints);
        for (const fixed of constraints.fixedNodeConstraint ?? []) {
          if (core.getElementById(fixed.nodeId).empty()) throw new Error(`Missing layout anchor: ${fixed.nodeId}`);
        }
        return { run: () => undefined } as unknown as ReturnType<Core["layout"]>;
      });
      renderer.instances.push(core);
      return core;
    },
    { use: cytoscape.use },
  );
  return { default: factory };
});

import GraphResultView from "../GraphResultView.vue";

function node(id: string, value = id): GraphNode {
  return { id, vid: { type: "string", value: id }, labels: ["Person"], properties: [{ owner: "Person", name: "name", type: "string", value }] };
}

function graph(...nodes: GraphNode[]): GraphResult {
  return { nodes, edges: [], cells: nodes.map((item, row) => ({ row, column: 0, kind: "vertex", nodeIds: [item.id], edgeIds: [] })) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mounted: { app: App; host: HTMLDivElement }[] = [];
async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountGraph(initial: GraphResult, actions: Partial<InstanceType<typeof GraphResultView>["$props"]> = {}) {
  const state = reactive({ graph: initial });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({ setup: () => () => h(GraphResultView, { graph: state.graph, rows: state.graph.nodes.map((item) => [item.id]), columns: ["v"], ...actions }) }));
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  await flush();
  return { state, host, app };
}

function core() {
  return renderer.instances.at(-1)!;
}

async function select(id: string) {
  core().getElementById(id).emit("tap");
  await flush();
}

async function click(host: HTMLElement, label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="graph.${label}"], button[title="graph.${label}"]`) ?? [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === `graph.${label}`);
  expect(button).toBeDefined();
  button!.click();
  await flush();
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  renderer.instances.length = 0;
  renderer.layouts.length = 0;
});

describe("graph result request isolation", () => {
  it.each(["string", "bool", "int", "float"])("does not offer edits for a NULL %s property", async (type) => {
    const vertex = node("null-node");
    vertex.properties = [{ owner: "Person", name: "nullable", type, value: null }];
    const saveProperty = vi.fn();
    const { host } = await mountGraph(graph(vertex), { saveProperty });
    await select("null-node");
    const button = [...host.querySelectorAll<HTMLButtonElement>("aside button")].find((item) => item.textContent?.trim() === "NULL");
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    button!.click();
    await flush();
    expect(host.querySelector('input[aria-label="nullable"]')).toBeNull();
    expect(saveProperty).not.toHaveBeenCalled();
  });
  it("discards an expansion after replacing the result, even with overlapping identities", async () => {
    const pending = deferred<GraphResult>();
    const { state, host } = await mountGraph(graph(node("shared")), { expandNode: () => pending.promise });
    await select("shared");
    await click(host, "expand");
    state.graph = graph(node("shared", "other database"));
    await flush();
    pending.resolve(graph(node("stale-neighbor")));
    await flush();
    expect(
      core()
        .nodes()
        .map((item) => item.id()),
    ).toEqual(["shared"]);
    expect(host.textContent).not.toContain("stale-neighbor");
  });

  it("does not release a new request's busy state when an old request finishes", async () => {
    const oldRequest = deferred<GraphResult>();
    const newRequest = deferred<GraphResult>();
    const expandNode = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const { state, host } = await mountGraph(graph(node("a")), { expandNode });
    await select("a");
    await click(host, "expand");
    state.graph = graph(node("b"));
    await flush();
    await select("b");
    await click(host, "expand");
    expect(expandNode).toHaveBeenCalledTimes(2);
    oldRequest.resolve(graph(node("old")));
    await flush();
    await click(host, "expand");
    expect(expandNode).toHaveBeenCalledTimes(2);
    newRequest.resolve(graph(node("new")));
    await flush();
    expect(
      core()
        .nodes()
        .map((item) => item.id()),
    ).toEqual(["b", "new"]);
  });

  it("ignores stale errors and saves after result replacement or unmount", async () => {
    const pending = deferred<GraphProperty>();
    const first = graph(node("shared", "first"));
    const { state, host } = await mountGraph(first, { saveProperty: () => pending.promise });
    await select("shared");
    host.querySelector<HTMLButtonElement>("aside button.hover\\:underline")!.click();
    await flush();
    await click(host, "save");
    state.graph = graph(node("shared", "second"));
    await flush();
    pending.reject(new Error("stale save error"));
    await flush();
    expect(host.textContent).not.toContain("stale save error");
    expect(state.graph.nodes[0].properties[0].value).toBe("second");
    const unmountedSave = deferred<GraphProperty>();
    const second = await mountGraph(graph(node("c")), { saveProperty: () => unmountedSave.promise });
    await select("c");
    second.host.querySelector<HTMLButtonElement>("aside button.hover\\:underline")!.click();
    await flush();
    await click(second.host, "save");
    second.app.unmount();
    mounted.splice(
      mounted.findIndex((item) => item.app === second.app),
      1,
    );
    second.host.remove();
    unmountedSave.resolve({ owner: "Person", name: "name", type: "string", value: "changed" });
    await flush();
    expect(second.state.graph.nodes[0].properties[0].value).toBe("c");
  });

  it("updates the saved entity rather than a newly selected node", async () => {
    const pending = deferred<GraphProperty>();
    const { state, host } = await mountGraph(graph(node("a"), node("b")), { saveProperty: () => pending.promise });
    await select("a");
    host.querySelector<HTMLButtonElement>("aside button.hover\\:underline")!.click();
    await flush();
    await click(host, "save");
    await select("b");
    pending.resolve({ owner: "Person", name: "name", type: "string", value: "updated-a" });
    await flush();
    expect(state.graph.nodes.map((item) => item.properties[0].value)).toEqual(["updated-a", "b"]);
    expect(core().getElementById("a").data("label")).toBe("updated-a");
    expect(core().getElementById("b").data("label")).toBe("b");
  });

  it("does not replace original record cell mappings with expansion rows", async () => {
    const { host } = await mountGraph(graph(node("a")), { expandNode: async () => graph(node("neighbor")) });
    await select("a");
    await click(host, "expand");
    await click(host, "records");
    host.querySelector<HTMLButtonElement>("tbody button")!.click();
    await flush();
    expect(core().getElementById("a").selected()).toBe(true);
    expect(core().getElementById("neighbor").selected()).toBe(false);
  });

  it("keeps the draft and reports a save conflict instead of closing the editor", async () => {
    const { host } = await mountGraph(graph(node("a")), {
      saveProperty: async () => {
        throw new Error("Graph property changed concurrently");
      },
    });
    await select("a");
    host.querySelector<HTMLButtonElement>("aside button.hover\\:underline")!.click();
    await flush();
    await click(host, "save");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="name"]')!.value).toBe("a");
    expect(host.textContent).toContain("Graph property changed concurrently");
  });

  it("lets an in-flight expansion complete across a page append", async () => {
    const pending = deferred<GraphResult>();
    const a = node("a");
    const { state, host } = await mountGraph(graph(a), { expandNode: () => pending.promise });
    await select("a");
    await click(host, "expand");
    state.graph = graph(a, node("page-two"));
    await flush();
    pending.resolve(graph(node("neighbor")));
    await flush();
    expect(
      core()
        .nodes()
        .map((item) => item.id()),
    ).toEqual(["a", "page-two", "neighbor"]);
  });
});

describe("graph result layout and append", () => {
  it("drops removed layout anchors when hiding a node exposes the 1,001st node", async () => {
    const { host } = await mountGraph(graph(...Array.from({ length: 1001 }, (_, index) => node(`n${index}`))));
    await select("n0");
    await click(host, "hide");
    expect(core().nodes()).toHaveLength(1000);
    expect(core().getElementById("n0").empty()).toBe(true);
    expect(core().getElementById("n1000").nonempty()).toBe(true);
    const anchors = renderer.layouts.at(-1)!.fixedNodeConstraint!;
    expect(anchors).toHaveLength(999);
    expect(anchors.some((item) => item.nodeId === "n0")).toBe(false);
  });

  it("preserves expansion, selection, pins, hidden nodes, and positions on page append", async () => {
    const a = node("a");
    const b = node("b");
    const { state, host } = await mountGraph(graph(a, b), { expandNode: async () => graph(node("neighbor")) });
    await select("a");
    await click(host, "expand");
    await select("b");
    await click(host, "hide");
    await select("a");
    core().getElementById("a").position({ x: 150, y: 200 });
    await click(host, "pin");
    state.graph = graph(a, b, node("page-two"));
    await flush();
    expect(
      core()
        .nodes()
        .map((item) => item.id()),
    ).toEqual(["a", "page-two", "neighbor"]);
    expect(core().getElementById("a").selected()).toBe(true);
    expect(core().getElementById("a").locked()).toBe(true);
    expect(core().getElementById("a").position()).toEqual({ x: 150, y: 200 });
    expect(host.querySelector("aside")!.textContent).toContain("Person.name");
  });
});
