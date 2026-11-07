// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listObjectStatistics: vi.fn(),
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: (...args: unknown[]) => mocks.listObjectStatistics(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: mocks.ensureConnected,
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
      sidebarCopyTableNameSeparator: "newline",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
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
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    props: {
      modelValue: { type: String, default: "" },
      options: { type: Array, default: () => [] },
      loading: { type: Boolean, default: false },
      placeholder: { type: String, default: "" },
      searchPlaceholder: { type: String, default: "" },
      emptyText: { type: String, default: "" },
    },
    setup(props) {
      return () => h("div", { class: "searchable-select-stub", "data-value": props.modelValue, "data-count": String(props.options.length) }, [h("span", { class: "select-value" }, props.modelValue), h("span", { class: "select-count" }, String(props.options.length))]);
    },
  }),
}));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.({ onContextMenu: () => undefined, isOpen: false });
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

function ref<T>(value: T) {
  return { value };
}

const connection = {
  id: "mysql-options",
  name: "MySQL",
  db_type: "mysql",
  database: "demo",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function queryResult(columns: string[], rows: unknown[][]) {
  return { columns, rows, rows_affected: 0, execution_time_ms: 1, last_insert_id: null, truncation: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
  mocks.listSchemas.mockResolvedValue(["demo"]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listObjectStatistics.mockResolvedValue([{ name: "orders", schema: "demo", estimated_rows: 10, total_bytes: 2048, engine: "InnoDB", collation: "utf8mb4_0900_ai_ci" }]);
  mocks.executeQuery.mockImplementation((_connectionId: string, _database: string, sql: string) => {
    if (/SHOW ENGINES/i.test(sql))
      return Promise.resolve(
        queryResult(
          ["Engine", "Support"],
          [
            ["InnoDB", "DEFAULT"],
            ["MyISAM", "YES"],
          ],
        ),
      );
    if (/SHOW CHARACTER SET/i.test(sql))
      return Promise.resolve(
        queryResult(
          ["Charset", "Default collation"],
          [
            ["utf8mb4", "utf8mb4_0900_ai_ci"],
            ["gbk", "gbk_chinese_ci"],
          ],
        ),
      );
    if (/SHOW COLLATION/i.test(sql))
      return Promise.resolve(
        queryResult(
          ["Collation", "Charset", "Default"],
          [
            ["utf8mb4_0900_ai_ci", "utf8mb4", "Yes"],
            ["utf8mb4_general_ci", "utf8mb4", ""],
            ["gbk_chinese_ci", "gbk", "Yes"],
          ],
        ),
      );
    return Promise.resolve(queryResult([], []));
  });
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(stats?: unknown[]) {
  if (stats) mocks.listObjectStatistics.mockResolvedValue(stats);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "demo", schema: "demo" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalled());
  await vi.waitFor(() => expect(document.body.querySelector(".select-count")?.textContent).not.toBe("0"));
  return host;
}

function dialogButtonByText(text: string) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
}

describe("ObjectBrowser table option editor dialog", () => {
  it("fills the engine dropdown from SHOW ENGINES", async () => {
    const host = await mountBrowser();
    const engineButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("title") === "InnoDB");
    expect(engineButton).toBeTruthy();
    engineButton!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("mysql-options", "demo", "SHOW ENGINES", undefined, undefined, { maxRows: 500 }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("ALTER TABLE");
      const selects = [...document.body.querySelectorAll(".searchable-select-stub")];
      expect(selects.some((select) => select.getAttribute("data-count") === "2")).toBe(true);
    });
  });

  it("fills charset/collation dropdowns from SHOW CHARACTER SET and SHOW COLLATION", async () => {
    const host = await mountBrowser();
    const collationButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("title") === "utf8mb4_0900_ai_ci");
    expect(collationButton).toBeTruthy();
    collationButton!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("mysql-options", "demo", "SHOW CHARACTER SET", undefined, undefined, { maxRows: 1000 }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("DEFAULT CHARACTER SET");
      const selects = [...document.body.querySelectorAll(".searchable-select-stub")];
      // 字符集下拉 2 项、排序规则下拉 2 项（当前字符集 utf8mb4 下）
      expect(selects.some((select) => select.getAttribute("data-count") === "2")).toBe(true);
      expect(selects.some((select) => select.getAttribute("data-value") === "utf8mb4")).toBe(true);
      expect(selects.some((select) => select.getAttribute("data-value") === "utf8mb4_0900_ai_ci")).toBe(true);
    });
  });

  it("blocks applying a risky charset change until acknowledged", async () => {
    const host = await mountBrowser([{ name: "orders", schema: "demo", estimated_rows: 600_000, total_bytes: 2048, engine: "InnoDB", collation: "utf8mb4_0900_ai_ci" }]);
    const collationButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("title") === "utf8mb4_0900_ai_ci");
    collationButton!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("objects.riskAcknowledge"));
    const applyButton = dialogButtonByText("common.apply")!;
    expect(applyButton.hasAttribute("disabled")).toBe(true);
  });

  it("reopens the dialog after closing it", async () => {
    const host = await mountBrowser();
    const engineButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("title") === "InnoDB")!;
    engineButton.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("mysql-options", "demo", "SHOW ENGINES", undefined, undefined, { maxRows: 500 }));
    dialogButtonByText("common.cancel")!.click();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("SHOW ENGINES"));
    // 取消后再点一次必须能重新打开（回归：关闭时未清编辑状态导致只能打开一次）。
    engineButton.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("ALTER TABLE"));
  });
});
