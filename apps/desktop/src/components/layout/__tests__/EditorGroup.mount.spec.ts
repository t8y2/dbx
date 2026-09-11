// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  surfaceCreated: 0,
  surfaceUnmounted: 0,
}));

vi.mock("@/components/layout/EditorGroupTabBar.vue", () => ({
  default: {
    name: "EditorGroupTabBarStub",
    template: `<div data-test="group-tabbar" />`,
  },
}));

vi.mock("@/components/layout/EditorToolbar.vue", () => ({
  default: {
    name: "EditorToolbarStub",
    props: ["activeTab"],
    template: `<div data-test="group-toolbar">{{ activeTab.id }}</div>`,
  },
}));

vi.mock("@/components/layout/QueryEditorSurface.vue", () => ({
  default: {
    name: "QueryEditorSurfaceStub",
    props: ["activeTab", "autoFocus"],
    created() {
      lifecycle.surfaceCreated += 1;
    },
    unmounted() {
      lifecycle.surfaceUnmounted += 1;
    },
    template: `<div data-test="query-editor">{{ activeTab.id }}</div>`,
  },
}));

vi.mock("@/components/layout/ContentArea.vue", () => ({
  default: {
    name: "ContentAreaStub",
    created() {
      lifecycle.surfaceCreated += 1;
    },
    unmounted() {
      lifecycle.surfaceUnmounted += 1;
    },
    template: `<div data-test="content-area" />`,
  },
}));

vi.mock("@/lib/backend/safeStorage", () => ({
  safeLocalStorageGet: () => null,
  safeLocalStorageSet: () => undefined,
}));

import EditorGroup from "../EditorGroup.vue";
import { createNoopEditorToolbarActions, EDITOR_TOOLBAR_ACTIONS, type EditorToolbarActions } from "../editorToolbarActions";
import { useQueryStore } from "@/stores/queryStore";

function tab(id: string, mode: "query" | "data" = "query") {
  return {
    id,
    title: id,
    connectionId: "conn-1",
    database: "db",
    sql: "SELECT 1",
    mode,
  } as const;
}

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("EditorGroup mount contract", () => {
  let pinia: ReturnType<typeof createPinia>;
  let i18n: ReturnType<typeof createI18n>;

  beforeEach(() => {
    document.body.innerHTML = "";
    lifecycle.surfaceCreated = 0;
    lifecycle.surfaceUnmounted = 0;
    pinia = createPinia();
    setActivePinia(pinia);
    i18n = createI18n({
      legacy: false,
      locale: "en",
      messages: { en: {} },
    });
  });

  it.each(["query", "data"] as const)("reuses hot %s tabs and remounts evicted surfaces", async (mode) => {
    const store = useQueryStore();
    const tabIds = ["tab-a", "tab-b", "tab-c", "tab-d"];
    store.tabs = tabIds.map((tabId) => tab(tabId, mode));
    const activeTabId = ref("tab-a");
    const host = createHost();
    const root = defineComponent({
      setup() {
        return () =>
          h(EditorGroup, {
            groupId: "group-1",
            tabIds,
            activeTabId: activeTabId.value,
            activeTab: tab(activeTabId.value, mode),
            activeConnection: undefined,
            executableSql: "SELECT 1",
            activeOutputView: "result",
            formatSqlRequest: null,
            compressSqlRequest: null,
            selectedSql: "",
            cursorPos: 0,
            blockDangerousRedisCommands: false,
          });
      },
    });
    const app = createApp(root);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    activeTabId.value = "tab-b";
    await nextTick();
    activeTabId.value = "tab-a";
    await nextTick();

    expect(lifecycle.surfaceCreated).toBe(2);
    expect(lifecycle.surfaceUnmounted).toBe(0);

    activeTabId.value = "tab-c";
    await nextTick();
    expect(lifecycle.surfaceCreated).toBe(3);
    expect(lifecycle.surfaceUnmounted).toBe(0);

    activeTabId.value = "tab-d";
    await nextTick();
    expect(lifecycle.surfaceCreated).toBe(4);
    expect(lifecycle.surfaceUnmounted).toBe(1);

    activeTabId.value = "tab-a";
    await nextTick();
    expect(lifecycle.surfaceCreated).toBe(4);
    expect(lifecycle.surfaceUnmounted).toBe(1);

    activeTabId.value = "tab-b";
    await nextTick();
    expect(lifecycle.surfaceCreated).toBe(5);
    expect(lifecycle.surfaceUnmounted).toBe(2);

    app.unmount();
    expect(lifecycle.surfaceUnmounted).toBe(5);
    host.remove();
  });

  it("passes the group active tab to the query editor surface instead of the global active tab", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a"), tab("tab-b")];

    const host = createHost();
    const app = createApp(EditorGroup, {
      groupId: "group-1",
      tabIds: ["tab-a", "tab-b"],
      activeTabId: "tab-b",
      // Global active tab is intentionally different from the group active tab.
      activeTab: tab("tab-a"),
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const editor = host.querySelector<HTMLElement>('[data-test="query-editor"]');
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toBe("tab-b");

    app.unmount();
    host.remove();
  });

  it("renders its own toolbar for query tabs and routes events to the injected actions", async () => {
    const store = useQueryStore();
    const queryId = store.createTab("pg-1", "app", "Query 1", "query");
    const dataId = store.createTab("pg-1", "app", "rows", "data", "public");

    const actions: EditorToolbarActions = {
      ...createNoopEditorToolbarActions(),
      cancelExecution: vi.fn(),
      explain: vi.fn(),
      saveSql: vi.fn(),
    };

    const host = createHost();
    const app = createApp(EditorGroup, {
      groupId: "group-1",
      tabIds: [queryId, dataId],
      activeTabId: queryId,
      activeTab: tab(queryId),
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
    });
    app.provide(EDITOR_TOOLBAR_ACTIONS, actions);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    // Query tab: the group carries its own toolbar bound to the group tab.
    const toolbar = host.querySelector<HTMLElement>('[data-test="group-toolbar"]');
    expect(toolbar?.textContent).toBe(queryId);

    // Toolbar events flow to the injected actions with the group's tab id.
    (toolbar as any).__vueParentComponent.emit("cancel");
    (toolbar as any).__vueParentComponent.emit("explain");
    (toolbar as any).__vueParentComponent.emit("saveSql", queryId);
    await nextTick();
    expect(actions.cancelExecution).toHaveBeenCalledWith(queryId);
    expect(actions.explain).toHaveBeenCalledWith(queryId);
    expect(actions.saveSql).toHaveBeenCalledWith(queryId);

    // Data tab: no SQL toolbar — the data grid carries its own built-in bar.
    app.unmount();
    const app2 = createApp(EditorGroup, {
      groupId: "group-1",
      tabIds: [queryId, dataId],
      activeTabId: dataId,
      activeTab: tab(queryId),
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
    });
    app2.provide(EDITOR_TOOLBAR_ACTIONS, actions);
    app2.use(pinia);
    app2.use(i18n);
    app2.mount(host);
    await nextTick();

    expect(host.querySelector('[data-test="group-toolbar"]')).toBeNull();
    expect(host.querySelector('[data-test="content-area"]')).not.toBeNull();

    app2.unmount();
    host.remove();
  });
});
