// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, onMounted, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult, QueryTab } from "@/types/database";
import type { GraphEdge, GraphNode, GraphProperty, GraphResult } from "@/lib/graph/graphResult";

interface GraphActions {
  graph: GraphResult;
  saveProperty: (entity: GraphNode | GraphEdge, property: GraphProperty, value: string | boolean) => Promise<GraphProperty | undefined>;
  expandNode: (node: GraphNode) => Promise<GraphResult | undefined>;
}

const graphViews = vi.hoisted(() => [] as GraphActions[]);
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGridColumnLayoutPopover.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/graph/GraphResultView.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: ["graph", "rows", "columns", "readOnly", "saveProperty", "expandNode"],
    setup(props) {
      onMounted(() => graphViews.push(props as unknown as GraphActions));
      return () => h("div", { "data-test": "graph-view" });
    },
  }),
}));

import ContentArea from "../ContentArea.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

function node(): GraphNode {
  return { id: "shared", vid: { type: "string", value: "shared" }, labels: ["Person"], properties: [{ owner: "Person", name: "age", type: "int", value: "20" }] };
}

function result(count = 1): QueryResult {
  return {
    columns: ["v"],
    rows: Array.from({ length: count }, () => ["original"]),
    affected_rows: 0,
    execution_time_ms: 0,
    graph_data: { nodes: [node()], edges: [], cells: Array.from({ length: count }, (_, row) => ({ row, column: 0, kind: "vertex", nodeIds: ["shared"], edgeIds: [] })) },
  };
}

function response(value: string): QueryResult {
  return { columns: ["dbx_value"], rows: [[value]], affected_rows: 0, execution_time_ms: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const mounted: { app: App; host: HTMLDivElement }[] = [];
async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountContentArea(production = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = ["a", "b"].map((id): ConnectionConfig => ({ id, name: `Synthetic ${id}`, db_type: "nebula", driver_profile: "nebula-v3", host: "localhost", port: 9669, username: "", password: "", is_production: production }));
  const queryStore = useQueryStore();
  queryStore.tabs = ["a", "b"].map((id): QueryTab => ({ id, title: id, connectionId: id, database: `space_${id}`, mode: "query", sql: "MATCH (v) RETURN v", isExecuting: false, isCancelling: false, isExplaining: false, resultViewGeneration: `generation-${id}`, result: result(id === "a" ? 1 : 2) }));
  const state = reactive({ activeTab: queryStore.tabs[0] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ContentArea, {
          activeTab: state.activeTab,
          activeConnection: connectionStore.getConfig(state.activeTab.connectionId),
          activeOutputView: "graph",
          executableSql: state.activeTab.sql,
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          blockDangerousRedisCommands: false,
          resultOnly: true,
        }),
    }),
  );
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  await flush();
  expect(graphViews).toHaveLength(1);
  return { state, queryStore, connectionStore, safetyStore: useProductionSafetyStore() };
}

function save(actions: GraphActions, value = "22") {
  const entity = actions.graph.nodes[0];
  return actions.saveProperty(entity, entity.properties[0], value);
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  graphViews.length = 0;
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("ContentArea graph actions", () => {
  it("rejects a conditional update that returns a different stored value", async () => {
    const execute = vi.spyOn(api, "executeQuery").mockResolvedValue(response("21"));
    const { state } = await mountContentArea();
    await expect(save(graphViews[0])).rejects.toThrow("graph.conflict");
    expect(execute).toHaveBeenCalledWith("a", "space_a", expect.stringContaining("WHEN `age` == 20"), undefined, undefined, { maxRows: 1 });
    expect(state.activeTab.result!.graph_data!.nodes[0].properties[0].value).toBe("20");
    expect(state.activeTab.result!.rows[0][0]).toBe("original");
  });

  it("applies a confirmed returned value to the graph and direct table cells", async () => {
    vi.spyOn(api, "executeQuery").mockResolvedValue(response("22"));
    const { state } = await mountContentArea();
    await expect(save(graphViews[0])).resolves.toEqual(expect.objectContaining({ value: "22" }));
    expect(state.activeTab.result!.graph_data!.nodes[0].properties[0].value).toBe("22");
    expect(state.activeTab.result!.rows[0][0]).toContain("age: 22");
  });

  it("discards an expansion when switching to a tab with a superset of the same IDs", async () => {
    const pending = deferred<QueryResult>();
    const execute = vi.spyOn(api, "executeQuery").mockReturnValue(pending.promise);
    const { state, queryStore } = await mountContentArea();
    const expansion = graphViews[0].expandNode(graphViews[0].graph.nodes[0]);
    state.activeTab = queryStore.tabs[1];
    await flush();
    expect(graphViews).toHaveLength(2);
    pending.resolve(result());
    await expect(expansion).resolves.toBeUndefined();
    expect(execute.mock.calls[0].slice(0, 2)).toEqual(["a", "space_a"]);
    expect(state.activeTab.result!.graph_data!.nodes).toHaveLength(1);
  });

  it("does not dispatch a save if the tab changed during production confirmation", async () => {
    const execute = vi.spyOn(api, "executeQuery").mockResolvedValue(response("22"));
    const { state, queryStore, safetyStore } = await mountContentArea(true);
    const confirmation = deferred<boolean>();
    vi.spyOn(safetyStore, "requestConfirmation").mockReturnValue(confirmation.promise);
    const saved = save(graphViews[0]);
    state.activeTab = queryStore.tabs[1];
    await flush();
    confirmation.resolve(true);
    await expect(saved).rejects.toThrow("graph.resultChanged");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not apply a completed save to another tab or after returning to the old tab", async () => {
    const pending = deferred<QueryResult>();
    vi.spyOn(api, "executeQuery").mockReturnValue(pending.promise);
    const { state, queryStore } = await mountContentArea();
    const saved = save(graphViews[0]);
    state.activeTab = queryStore.tabs[1];
    await flush();
    pending.resolve(response("22"));
    await expect(saved).resolves.toBeUndefined();
    expect(state.activeTab.result!.graph_data!.nodes[0].properties[0].value).toBe("20");
    state.activeTab = queryStore.tabs[0];
    await flush();
    expect(state.activeTab.result!.graph_data!.nodes[0].properties[0].value).toBe("20");
  });

  it("reuses the view on append but remounts when the logical query generation changes", async () => {
    const { state } = await mountContentArea();
    state.activeTab.result = result(2);
    await flush();
    expect(graphViews).toHaveLength(1);
    state.activeTab.resultViewGeneration = "new-query-with-the-same-node-ids";
    await flush();
    expect(graphViews).toHaveLength(2);
  });

  it("applies an in-flight save to the appended result of the same query", async () => {
    const pending = deferred<QueryResult>();
    vi.spyOn(api, "executeQuery").mockReturnValue(pending.promise);
    const { state } = await mountContentArea();
    const saved = save(graphViews[0]);
    state.activeTab.result = result(2);
    await flush();
    pending.resolve(response("22"));
    await expect(saved).resolves.toEqual(expect.objectContaining({ value: "22" }));
    expect(state.activeTab.result!.rows.every((row) => String(row[0]).includes("age: 22"))).toBe(true);
  });
});
