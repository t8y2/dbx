// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { invalidateMetadataRuntimeCachePrefix } from "@/lib/metadata/metadataRuntimeCache";
import { escapeHtml } from "@/lib/sql/sqlHighlighter";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listSchemas: vi.fn().mockResolvedValue(["TESTER"]),
  listConstraints: vi.fn(),
  getTableComment: vi.fn(),
  getTablePartitionStatus: vi.fn(),
  getTablePartitioning: vi.fn(),
  toast: vi.fn(),
  getTableDisplayDdl: vi.fn(),
  highlight: vi.fn(),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(async () => true),
}));
vi.mock("@/lib/backend/api", () => ({
  listObjects: vi.fn().mockResolvedValue([{ name: "O01_CONSTRAINTS", object_type: "TABLE", schema: "TESTER" }]),
  listSchemas: mocks.listSchemas,
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getTableDisplayDdl: (...args: unknown[]) => mocks.getTableDisplayDdl(...args),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  listConstraints: (...args: unknown[]) => mocks.listConstraints(...args),
  getTableComment: (...args: unknown[]) => mocks.getTableComment(...args),
  getTablePartitionStatus: (...args: unknown[]) => mocks.getTablePartitionStatus(...args),
  getTablePartitioning: (...args: unknown[]) => mocks.getTablePartitioning(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  cancelQuery: (...args: unknown[]) => mocks.cancelQuery(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    completionCacheRevision: () => 0,
    readVisibleSchemaSelection: async () => {
      const names = await mocks.listSchemas();
      return { names, infos: [], systemNames: new Set<string>(), visibleNames: names, oracleMaintainedSchemas: undefined };
    },
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    tableNameFilterForScope: () => undefined,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarActivation: "double",
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => mocks.highlight(sql) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "ob-ddl-search", name: "MySQL", db_type: "mysql", database: "app", driver_profile: null, url_params: null, transport_layers: [] } as unknown as ConnectionConfig;
const ddl = "CREATE TABLE O01_CONSTRAINTS (\n  first_type VARCHAR(50),\n  second_type VARCHAR(50),\n  third_type VARCHAR(50)\n)";
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableDisplayDdl.mockReset().mockResolvedValue(ddl);
  mocks.highlight.mockImplementation((sql: string) => `<span>${escapeHtml(sql)}</span>`);
  mocks.getTablePartitionStatus.mockResolvedValue({ isPartitionedParent: false, isPartition: false });
  invalidateObjectBrowserRowsCache({});
  invalidateMetadataRuntimeCachePrefix("");
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  invalidateObjectBrowserRowsCache({});
  invalidateMetadataRuntimeCachePrefix("");
});

async function openDdl() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(ObjectBrowser, { connection, database: "app", schema: "app" });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector('[title="O01_CONSTRAINTS"]')).not.toBeNull());
  host.querySelector<HTMLElement>('[title="O01_CONSTRAINTS"]')!.closest<HTMLElement>(".cursor-default")!.click();
  await vi.waitFor(() => expect(host.querySelector("pre.ddl-code")?.textContent).toBe(ddl));
  return host;
}

async function search(host: HTMLElement, query: string) {
  const input = host.querySelector<HTMLInputElement>("[data-table-info-search]")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  return input;
}

async function key(input: HTMLInputElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  input.dispatchEvent(event);
  await nextTick();
  return event;
}

function result(host: HTMLElement) {
  return host.querySelector('[aria-live="polite"]')?.textContent?.trim();
}

function activeMatch(host: HTMLElement) {
  return host.querySelector("mark.ddl-search-match-active");
}

describe("对象浏览器 DDL 搜索", () => {
  it("输入后定位首项，回车前进、Shift+Enter 后退并循环，且不重新请求或高亮整段 DDL", async () => {
    const host = await openDdl();
    const highlights = mocks.highlight.mock.calls.length;
    const input = await search(host, "type");
    const marks = host.querySelectorAll("mark.ddl-search-match");
    expect(result(host)).toBe("1/3");
    expect(activeMatch(host)).toBe(marks[0]);
    expect((await key(input, "Enter")).defaultPrevented).toBe(true);
    expect(result(host)).toBe("2/3");
    expect(activeMatch(host)).toBe(marks[1]);
    await key(input, "Enter");
    await key(input, "Enter");
    expect(result(host)).toBe("1/3");
    await key(input, "Enter", { shiftKey: true });
    expect(result(host)).toBe("3/3");
    expect(activeMatch(host)).toBe(marks[2]);
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
    expect(mocks.highlight).toHaveBeenCalledTimes(highlights);
    expect(host.querySelector("pre.ddl-code")!.textContent).toBe(ddl);
  });

  it("只调整 DDL 容器的滚动位置，保留搜索框焦点", async () => {
    const host = await openDdl();
    const pre = host.querySelector<HTMLPreElement>("pre.ddl-code")!;
    Object.defineProperties(pre, { clientHeight: { value: 200 }, clientWidth: { value: 400 } });
    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({ top: 100, left: 50 } as DOMRect);
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "MARK" ? ({ top: 800, left: 700, height: 20, width: 40 } as DOMRect) : original.call(this);
    });
    const input = host.querySelector<HTMLInputElement>("[data-table-info-search]")!;
    input.focus();
    await search(host, "type");
    expect(pre.scrollTop).toBe(610);
    expect(pre.scrollLeft).toBe(470);
    expect(host.scrollTop).toBe(0);
    expect(document.activeElement).toBe(input);
  });

  it("支持上下按钮，关键词变化后回到首项，Esc 清空标记", async () => {
    const host = await openDdl();
    const input = await search(host, "type");
    host.querySelector<HTMLButtonElement>('[aria-label="editor.search.nextMatch"]')!.click();
    await nextTick();
    expect(result(host)).toBe("2/3");
    host.querySelector<HTMLButtonElement>('[aria-label="editor.search.prevMatch"]')!.click();
    await nextTick();
    expect(result(host)).toBe("1/3");
    await key(input, "Enter");
    await search(host, "VARCHAR");
    expect(result(host)).toBe("1/3");
    expect((await key(input, "Escape")).defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(result(host)).toBe("");
    expect(host.querySelector("mark")).toBeNull();
  });

  it.each(["VARCHAR(50)", "["])("按字面搜索特殊字符 %s，无匹配时禁用导航", async (query) => {
    const host = await openDdl();
    const input = await search(host, query);
    expect(result(host)).toBe(query === "[" ? "0" : "1/3");
    if (query !== "[") {
      expect(activeMatch(host)?.textContent).toBe(query);
      return;
    }
    expect(host.querySelector<HTMLButtonElement>('[aria-label="editor.search.nextMatch"]')!.disabled).toBe(true);
    await key(input, "Enter");
    expect(result(host)).toBe("0");
    expect(host.querySelector("pre.ddl-code")!.textContent).toBe(ddl);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("输入法确认文字时不跳转：%j", async (options) => {
    const host = await openDdl();
    const input = await search(host, "type");
    expect((await key(input, "Enter", options)).defaultPrevented).toBe(false);
    expect(result(host)).toBe("1/3");
  });

  it("离开 DDL 标签后不拦截回车，返回 DDL 时重新标记且保留复制全选", async () => {
    const host = await openDdl();
    const input = await search(host, "type");
    await key(input, "Enter");
    host.querySelector<HTMLButtonElement>('button[title="grid.tableInfoOverview"]')!.click();
    await nextTick();
    expect(host.querySelector("pre.ddl-code")).toBeNull();
    expect((await key(input, "Enter")).defaultPrevented).toBe(false);
    host.querySelector<HTMLButtonElement>('button[title="DDL"]')!.click();
    await nextTick();
    expect(input.value).toBe("");
    await search(host, "type");
    await vi.waitFor(() => expect(result(host)).toBe("1/3"));
    const pre = host.querySelector<HTMLPreElement>("pre.ddl-code")!;
    pre.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(window.getSelection()?.toString()).toBe(ddl);
  });

  it("刷新 DDL 后更新计数、重置当前位置并标记新内容", async () => {
    const host = await openDdl();
    const input = await search(host, "type");
    await key(input, "Enter");
    mocks.getTableDisplayDdl.mockResolvedValueOnce("CREATE TABLE O01_CONSTRAINTS (only_type INT)");
    host.querySelector<HTMLButtonElement>('[aria-label="structureEditor.refresh"]')!.click();
    await vi.waitFor(() => expect(result(host)).toBe("1/1"));
    expect(host.querySelectorAll("mark.ddl-search-match")).toHaveLength(1);
    expect(activeMatch(host)?.textContent).toBe("type");
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });
});
