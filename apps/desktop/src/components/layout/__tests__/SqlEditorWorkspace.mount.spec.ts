// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("splitpanes", () => ({
  Splitpanes: {
    name: "SplitpanesStub",
    template: `<div class="splitpanes-stub"><slot /></div>`,
  },
  Pane: {
    name: "PaneStub",
    template: `<div class="pane-stub"><slot /></div>`,
  },
}));

const editorPreviewCalls = vi.hoisted(() => [] as Array<{ tabId: string; range: unknown }>);
const editorFocusCalls = vi.hoisted(() => [] as Array<{ tabId: string; range: unknown }>);
const groupHandleModRCalls = vi.hoisted(() => [] as Element[]);
const groupFocusSearchCalls = vi.hoisted(() => [] as Array<Element | null>);
const resultHandleModRCalls = vi.hoisted(() => [] as Element[]);
const resultFocusSearchCalls = vi.hoisted(() => [] as boolean[]);

vi.mock("@/components/layout/EditorGroup.vue", () => ({
  default: {
    name: "EditorGroupStub",
    props: ["groupId", "tabIds", "activeTabId"],
    emits: ["execute"],
    methods: {
      previewStatementRange(tabId: string, range: unknown) {
        editorPreviewCalls.push({ tabId, range });
        return true;
      },
      focusStatementRange(tabId: string, range: unknown) {
        editorFocusCalls.push({ tabId, range });
        return true;
      },
      handleModRTarget(target: Element) {
        groupHandleModRCalls.push(target);
        return true;
      },
      focusSearch(target?: Element | null) {
        groupFocusSearchCalls.push(target ?? null);
        return true;
      },
    },
    template: `<div data-test="editor-group" :data-group-id="groupId" :data-tab-ids="tabIds.join(',')" :data-active-tab-id="activeTabId"><button data-test="emit-execute" @click="$emit('execute', { fullSql: 'SELECT 1', selectedSql: 'SELECT 1', cursorPos: 0, selectionFrom: 0, selectionTo: 8 })">execute</button></div>`,
  },
}));

vi.mock("@/components/layout/EditorToolbar.vue", () => ({
  default: {
    name: "EditorToolbarStub",
    props: ["activeTab"],
    template: `<div data-test="group-toolbar" />`,
  },
}));

vi.mock("@/components/layout/QueryResultSurface.vue", () => ({
  default: {
    name: "QueryResultSurfaceStub",
    props: ["activeTab"],
    emits: ["previewStatement", "focusStatement"],
    methods: {
      handleModRTarget(target: Element) {
        resultHandleModRCalls.push(target);
        return true;
      },
      focusSearch() {
        resultFocusSearchCalls.push(true);
        return true;
      },
    },
    template: `<div data-test="result-surface">{{ activeTab?.id }}<button data-test="emit-preview" @click="$emit('previewStatement', 'tab-a', { from: 0, to: 8 })">preview</button><button data-test="emit-focus" @click="$emit('focusStatement', 'tab-a', { from: 0, to: 8 })">focus</button></div>`,
  },
}));

import SqlEditorWorkspace from "../SqlEditorWorkspace.vue";
import { useQueryStore } from "@/stores/queryStore";

function tab(id: string) {
  return {
    id,
    title: id,
    connectionId: "conn-1",
    database: "db",
    sql: "SELECT 1",
    mode: "query",
  } as const;
}

function dataTab(id: string) {
  return { ...tab(id), mode: "data" };
}

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("SqlEditorWorkspace mount contract", () => {
  let pinia: ReturnType<typeof createPinia>;
  let i18n: ReturnType<typeof createI18n>;

  beforeEach(() => {
    document.body.innerHTML = "";
    editorPreviewCalls.length = 0;
    editorFocusCalls.length = 0;
    groupHandleModRCalls.length = 0;
    groupFocusSearchCalls.length = 0;
    resultHandleModRCalls.length = 0;
    resultFocusSearchCalls.length = 0;
    pinia = createPinia();
    setActivePinia(pinia);
    i18n = createI18n({
      legacy: false,
      locale: "en",
      messages: { en: {} },
    });
  });

  it("renders one editor group per store group and binds the shared result to the global active tab", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a"), tab("tab-b")];
    store.activeTabId = "tab-a";
    store.groups = [
      { id: "g1", tabIds: ["tab-a"], activeTabId: "tab-a" },
      { id: "g2", tabIds: ["tab-b"], activeTabId: "tab-b" },
    ];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [50, 50];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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

    const groups = host.querySelectorAll('[data-test="editor-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute("data-group-id")).toBe("g1");
    expect(groups[0]?.getAttribute("data-tab-ids")).toBe("tab-a");
    expect(groups[1]?.getAttribute("data-group-id")).toBe("g2");
    expect(groups[1]?.getAttribute("data-tab-ids")).toBe("tab-b");

    const result = host.querySelector<HTMLElement>('[data-test="result-surface"]');
    expect(result?.textContent).toContain("tab-a");

    app.unmount();
    host.remove();
  });

  it("forwards editor execute events from EditorGroup to the App listener", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const onExecute = vi.fn();
    const app = createApp(SqlEditorWorkspace, {
      activeTab: tab("tab-a"),
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
      onExecute,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-test="emit-execute"]')?.click();
    await nextTick();

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ fullSql: "SELECT 1" });

    app.unmount();
    host.remove();
  });

  it("toggles the shared result pane through the exposed workspace method", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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
    const vm = app.mount(host) as any;
    await nextTick();

    expect(host.querySelector('[data-test="result-surface"]')).not.toBeNull();

    vm.toggleResultsPane();
    await nextTick();
    // Wait out the leave transition frame before asserting the unmount.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.querySelector('[data-test="result-surface"]')).toBeNull();

    app.unmount();
    host.remove();
  });

  it("routes result previewStatement events to the owning editor group", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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

    host.querySelector<HTMLButtonElement>('[data-test="emit-preview"]')?.click();
    await nextTick();

    expect(editorPreviewCalls).toEqual([{ tabId: "tab-a", range: { from: 0, to: 8 } }]);

    app.unmount();
    host.remove();
  });

  it("routes result focusStatement events to the owning editor group", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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

    host.querySelector<HTMLButtonElement>('[data-test="emit-focus"]')?.click();
    await nextTick();

    expect(editorFocusCalls).toEqual([{ tabId: "tab-a", range: { from: 0, to: 8 } }]);

    app.unmount();
    host.remove();
  });

  it("hides the shared result pane while a non-query tab is active and restores it for query tabs", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a"), dataTab("tab-data")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a", "tab-data"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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

    expect(host.querySelector('[data-test="result-surface"]')).not.toBeNull();

    store.activeTabId = "tab-data";
    await nextTick();
    // The leave transition keeps the surface in the DOM for one more frame
    // before unmounting it (CSS durations collapse to zero in the test env).
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(host.querySelector("[data-shared-result-surface]")).toBeNull();
    // Outer editor pane + always-mounted result pane (collapsed to size 0)
    // + one pane per group.
    expect(host.querySelectorAll(".pane-stub")).toHaveLength(3);

    store.activeTabId = "tab-a";
    await nextTick();

    expect(host.querySelector('[data-test="result-surface"]')).not.toBeNull();

    app.unmount();
    host.remove();
  });

  it("routes Mod+R grid targets to the shared result surface only while a query tab is active", async () => {
    const store = useQueryStore();
    store.tabs = [tab("tab-a"), dataTab("tab-data")];
    store.activeTabId = "tab-a";
    store.groups = [{ id: "g1", tabIds: ["tab-a", "tab-data"], activeTabId: "tab-a" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
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
    const vm = app.mount(host) as any;
    await nextTick();

    // Query tab: grid targets inside the shared result surface route to it.
    const resultGridEl = document.createElement("div");
    resultGridEl.setAttribute("data-grid-root", "");
    host.querySelector('[data-test="result-surface"]')?.appendChild(resultGridEl);
    expect(vm.handleModRTarget(resultGridEl)).toBe(true);
    expect(resultHandleModRCalls).toEqual([resultGridEl]);
    expect(groupHandleModRCalls).toEqual([]);

    // Query tab: the cell-detail editor is portaled to body, so it cannot be
    // resolved through the DOM — it still routes to the shared result surface.
    const portalEl = document.createElement("div");
    portalEl.setAttribute("data-cell-detail-editor-root", "");
    document.body.appendChild(portalEl);
    expect(vm.handleModRTarget(portalEl)).toBe(true);
    expect(resultHandleModRCalls).toEqual([resultGridEl, portalEl]);

    // Data tab: the grid and its cell-detail dialog belong to the group.
    groupHandleModRCalls.length = 0;
    resultHandleModRCalls.length = 0;
    store.activeTabId = "tab-data";
    await nextTick();

    const dataGridEl = document.createElement("div");
    dataGridEl.setAttribute("data-grid-root", "");
    host.querySelector('[data-test="editor-group"]')?.appendChild(dataGridEl);
    expect(vm.handleModRTarget(dataGridEl)).toBe(true);
    expect(groupHandleModRCalls).toEqual([dataGridEl]);
    expect(vm.handleModRTarget(portalEl)).toBe(true);
    expect(groupHandleModRCalls).toEqual([dataGridEl, portalEl]);
    expect(resultHandleModRCalls).toEqual([]);

    portalEl.remove();
    app.unmount();
    host.remove();
  });

  it("routes cell-detail search to the group's grid while a data tab is active", async () => {
    const store = useQueryStore();
    store.tabs = [dataTab("tab-data")];
    store.activeTabId = "tab-data";
    store.groups = [{ id: "g1", tabIds: ["tab-data"], activeTabId: "tab-data" }];
    store.focusedGroupId = "g1";
    store.orientation = "vertical";
    store.sizes = [100];

    const host = createHost();
    const app = createApp(SqlEditorWorkspace, {
      activeTab: dataTab("tab-data"),
      activeConnection: undefined,
      executableSql: "",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
    });
    app.use(pinia);
    app.use(i18n);
    const vm = app.mount(host) as any;
    await nextTick();

    const portalEl = document.createElement("div");
    portalEl.setAttribute("data-cell-detail-editor-root", "");
    document.body.appendChild(portalEl);
    expect(vm.focusSearch(portalEl)).toBe(true);
    expect(groupFocusSearchCalls.length).toBe(1);
    expect(resultFocusSearchCalls).toEqual([]);

    portalEl.remove();
    app.unmount();
    host.remove();
  });
});
