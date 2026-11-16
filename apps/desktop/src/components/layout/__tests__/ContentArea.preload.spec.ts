// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => null } }));
vi.mock("@/lib/backend/debugLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/debugLog")>()),
  isDebugLoggingEnabled: () => true,
  appendDebugLog: vi.fn(),
}));

import ContentArea from "../ContentArea.vue";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";

// Keep the real setup/watch lifecycle and props, without mounting editor/grid UI.
const PreloadSurface = { ...ContentArea, render: () => null };
const cleanups: Array<() => void> = [];
const result = { columns: ["id"], rows: [], affected_rows: 0, execution_time_ms: 1 };

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return { id: "query", title: "Query", connectionId: "mysql", database: "app", mode: "query", sql: "", isExecuting: false, ...overrides };
}

function sourceTab(): QueryTab {
  return queryTab({ id: "source", objectSource: { name: "view_users", objectType: "VIEW" }, sql: "CREATE VIEW view_users AS SELECT 1" });
}

function readOnlySourceTab(): QueryTab {
  return queryTab({ id: "readonly-source", sourceView: true, sql: "CREATE SEQUENCE seq_users" });
}

function previewTab(): QueryTab {
  return queryTab({ id: "preview", connectionId: "preview-connection" });
}

function connection(id: string, name: string): ConnectionConfig {
  return { id, name, db_type: "mysql", host: "localhost", port: 3306, username: "", password: "" };
}

function mountSurface(initialTab: QueryTab | (() => QueryTab)) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  connectionStore.connections = [connection("mysql", "Local MySQL"), connection("preview-connection", "[Preview] Imported SQL")];
  const state = reactive({ activeTab: typeof initialTab === "function" ? initialTab() : initialTab });
  const root = defineComponent({
    setup: () => () =>
      h(PreloadSurface, {
        activeTab: state.activeTab,
        activeConnection: connectionStore.getConfig(state.activeTab.connectionId),
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
        editorOnly: true,
      }),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(root);
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  return { state, connectionStore };
}

function loadStarts(): number {
  return vi.mocked(appendDebugLog).mock.calls.filter((call) => call[1] === "[DBX][DataGrid:load:start]").length;
}

describe("ContentArea grid preload behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await nextTick();
  });

  it.each(["query", "data"] as const)("preloads for an ordinary empty %s tab", async (mode) => {
    mountSurface(queryTab({ mode }));
    await nextTick();
    expect(loadStarts()).toBe(1);
  });

  it.each([
    ["object source", sourceTab],
    ["read-only source", readOnlySourceTab],
    ["Preview", previewTab],
  ] as const)("does not preload an idle %s query tab", async (_, createTab) => {
    mountSurface(createTab());
    await nextTick();
    expect(loadStarts()).toBe(0);
  });

  for (const [label, createTab] of [
    ["object source", sourceTab],
    ["read-only source", readOnlySourceTab],
    ["Preview", previewTab],
  ] as const) {
    it.each(["isExecuting", "isExplaining"] as const)(`preloads when an idle ${label} tab starts %s`, async (flag) => {
      const { state } = mountSurface(createTab());
      expect(loadStarts()).toBe(0);
      state.activeTab[flag] = true;
      await nextTick();
      expect(loadStarts()).toBe(1);
      state.activeTab[flag] = false;
      state.activeTab.result = result;
      await nextTick();
      expect(loadStarts()).toBe(1);
    });

    it(`preloads an existing result on an otherwise idle ${label} tab`, async () => {
      mountSurface({ ...createTab(), result });
      await nextTick();
      expect(loadStarts()).toBe(1);
    });

    it(`re-evaluates when a ${label} tab is replaced with an ordinary query of the same mode`, async () => {
      const { state } = mountSurface(createTab());
      expect(loadStarts()).toBe(0);
      state.activeTab = queryTab();
      await nextTick();
      expect(loadStarts()).toBe(1);
    });
  }

  it("does not preload a read-only source created by the store or enable source saving", async () => {
    const { state } = mountSurface(() => {
      const store = useQueryStore();
      const id = store.createTab("mysql", "app", "Source - seq_users", "query", "app", "CREATE SEQUENCE seq_users", undefined, { forceNew: true, sourceView: true });
      return store.tabs.find((tab) => tab.id === id)!;
    });
    await nextTick();
    expect(state.activeTab.objectSource).toBeUndefined();
    expect(loadStarts()).toBe(0);
    state.activeTab.isExecuting = true;
    await nextTick();
    expect(loadStarts()).toBe(1);
  });

  it("re-evaluates source metadata changes without changing the tab mode or id", async () => {
    const { state } = mountSurface(sourceTab());
    expect(loadStarts()).toBe(0);
    state.activeTab.objectSource = undefined;
    await nextTick();
    expect(loadStarts()).toBe(1);
  });

  it("uses the canonical Preview connection name and reacts when it becomes an ordinary connection", async () => {
    const { connectionStore } = mountSurface(previewTab());
    expect(loadStarts()).toBe(0);
    connectionStore.connections[1]!.name = "Local MySQL";
    await nextTick();
    expect(loadStarts()).toBe(1);
  });
});
