// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import i18n from "@/i18n";
import * as api from "@/lib/backend/api";
import DatabaseSearchPanel from "@/components/search/DatabaseSearchPanel.vue";

vi.mock("@/lib/backend/api", () => ({
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  getColumns: vi.fn(),
  executeQuery: vi.fn(),
  buildDatabaseSearchSql: vi.fn(),
  buildDatabaseSearchColumnsSql: vi.fn(),
  buildDatabaseSearchProbeSql: vi.fn(),
  buildSearchResultWhere: vi.fn(),
  cancelQuery: vi.fn(),
}));

const connectionConfig: { id: string; name: string; db_type: string; driver_profile: string | null } = {
  id: "conn-1",
  name: "test-conn",
  db_type: "dameng",
  driver_profile: null,
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => (connectionConfig.id === id ? connectionConfig : undefined),
    ensureConnected: vi.fn(async () => {}),
  }),
}));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean, variant: String, size: String },
      emits: ["click"],
      setup(props, { slots, emit }) {
        return () => h("button", { disabled: props.disabled, onClick: (e: MouseEvent) => emit("click", e) }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: [String, Number], disabled: Boolean, placeholder: String, type: String },
      emits: ["update:modelValue", "keydown"],
      setup(props, { emit }) {
        return () =>
          h("input", {
            value: props.modelValue,
            disabled: props.disabled,
            placeholder: props.placeholder,
            type: props.type || "text",
            onInput: (e: any) => emit("update:modelValue", e.target.value),
            onKeydown: (e: any) => emit("keydown", e),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      setup(_props, { slots }) {
        return () => h("span", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: passthrough };
});

const mountedApps: App[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  connectionConfig.db_type = "dameng";
});

afterEach(() => {
  // 模块工厂里的 vi.fn 不受 restoreAllMocks 影响,必须显式清调用历史与实现
  vi.clearAllMocks();
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

const TABLES = [
  { name: "USERS", table_type: "TABLE" },
  { name: "FILES", table_type: "TABLE" },
  { name: "V_ORDERS", table_type: "VIEW" },
];

const BULK_COLUMN_ROWS = {
  columns: ["table_name", "column_name", "data_type", "is_primary_key"],
  rows: [
    ["USERS", "ID", "NUMBER", 1],
    ["USERS", "EMAIL", "VARCHAR2", 0],
    ["FILES", "DATA", "BLOB", 0],
  ],
};

async function mountPanel() {
  vi.mocked(api.listTables).mockResolvedValue(TABLES as any);
  vi.mocked(api.getColumns).mockResolvedValue([]);
  vi.mocked(api.buildSearchResultWhere).mockResolvedValue('"ID" = 1');
  vi.mocked(api.buildDatabaseSearchSql).mockResolvedValue({ sql: "SELECT_USERS", searchableColumns: ["EMAIL"] });
  vi.mocked(api.buildDatabaseSearchColumnsSql).mockResolvedValue({ sql: "COLS_SQL" });
  vi.mocked(api.buildDatabaseSearchProbeSql).mockResolvedValue({ sql: "PROBE_SQL", includedIndices: [0] });

  const states: any[] = [];
  const panelRef = ref<any>(null);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DatabaseSearchPanel, {
            ref: panelRef,
            connectionId: "conn-1",
            database: "shop",
            schema: "DLWEB",
            initialState: { keyword: "admin" },
            inDialog: true,
            "onUpdate:state": (state: any) => states.push(state),
          });
      },
    }),
  );
  app.use(i18n);
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  return { panelRef, states };
}

describe("DatabaseSearchPanel scan flow", () => {
  it("bulk path: one columns query + one probe, fetch rows only for hit tables", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_conn: string, _db: string, sql: string) => {
      if (sql === "COLS_SQL") return BULK_COLUMN_ROWS as any;
      if (sql === "PROBE_SQL") return { columns: ["TABLE_LABEL", "HITS"], rows: [["t0", 2]] } as any;
      if (sql === "SELECT_USERS") return { columns: ["ID", "EMAIL"], rows: [[1, "admin@x.com"]] } as any;
      throw new Error(`unexpected sql: ${sql}`);
    });

    const { panelRef, states } = await mountPanel();
    await panelRef.value.startSearch();
    await vi.waitFor(() => {
      expect(states.at(-1)?.progressDone).toBe(2);
    });

    // 批量取列:一条目录查询,零次逐表 getColumns
    expect(api.buildDatabaseSearchColumnsSql).toHaveBeenCalledTimes(1);
    expect(api.getColumns).not.toHaveBeenCalled();

    // 探测:两个任务表(视图已被排除),只有 USERS 命中并取数
    expect(api.buildDatabaseSearchProbeSql).toHaveBeenCalledTimes(1);
    const probeArg = vi.mocked(api.buildDatabaseSearchProbeSql).mock.calls[0][0];
    expect(probeArg.tables.map((t: any) => t.tableName)).toEqual(["USERS", "FILES"]);
    expect(api.buildDatabaseSearchSql).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.buildDatabaseSearchSql).mock.calls[0][0].tableName).toBe("USERS");
    // 预取列被传入单表查询(证明不再走 getColumns)
    expect(vi.mocked(api.buildDatabaseSearchSql).mock.calls[0][0].columns.map((c: any) => c.name)).toEqual(["ID", "EMAIL"]);

    // 结果与回表条件一致
    const finalState = states.at(-1);
    expect(finalState.results).toHaveLength(1);
    expect(finalState.results[0].tableName).toBe("USERS");
    expect(finalState.results[0].whereInput).toBe('"ID" = 1');
    expect(finalState.progressTotal).toBe(2);
  });

  it("probe failure falls back to per-table scan for the whole batch", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_conn: string, _db: string, sql: string) => {
      if (sql === "COLS_SQL") return BULK_COLUMN_ROWS as any;
      if (sql === "PROBE_SQL") throw new Error("ORA-00942: table or view does not exist");
      if (sql === "SELECT_USERS") return { columns: ["ID", "EMAIL"], rows: [[1, "admin@x.com"]] } as any;
      throw new Error(`unexpected sql: ${sql}`);
    });

    const { panelRef, states } = await mountPanel();
    await panelRef.value.startSearch();
    await vi.waitFor(() => {
      expect(states.at(-1)?.progressDone).toBe(2);
    });

    // 整批回退:两张表都执行了逐表取数查询,列信息仍来自批量 Map
    expect(api.buildDatabaseSearchSql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.buildDatabaseSearchSql).mock.calls.map((c) => c[0].tableName)).toEqual(["USERS", "FILES"]);
    expect(api.getColumns).not.toHaveBeenCalled();
    // 失败被吞掉,不产生 generalError
    expect(states.at(-1)?.generalError).toBe("");
  });

  it("unsupported dialect silently falls back to per-table getColumns", async () => {
    connectionConfig.db_type = "sqlite";
    vi.mocked(api.getColumns).mockResolvedValue([{ name: "EMAIL", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null }] as any);
    vi.mocked(api.executeQuery).mockImplementation(async (_conn: string, _db: string, sql: string) => {
      if (sql === "SELECT_USERS") return { columns: ["EMAIL"], rows: [["admin@x.com"]] } as any;
      throw new Error(`unexpected sql: ${sql}`);
    });

    const { panelRef, states } = await mountPanel();
    await panelRef.value.startSearch();
    await vi.waitFor(() => {
      expect(states.at(-1)?.progressDone).toBe(2);
    });

    expect(api.buildDatabaseSearchColumnsSql).not.toHaveBeenCalled();
    expect(api.buildDatabaseSearchProbeSql).not.toHaveBeenCalled();
    expect(api.getColumns).toHaveBeenCalledTimes(2);
    expect(api.buildDatabaseSearchSql).toHaveBeenCalledTimes(2);
  });

  it("tables without probe hits advance progress without any fetch query", async () => {
    vi.mocked(api.executeQuery).mockImplementation(async (_conn: string, _db: string, sql: string) => {
      if (sql === "COLS_SQL") return BULK_COLUMN_ROWS as any;
      throw new Error(`unexpected sql: ${sql}`);
    });

    const { panelRef, states } = await mountPanel();
    // mountPanel 会设置默认探测 mock,这里在启动前覆盖为 null(全部无可搜列等价场景)
    vi.mocked(api.buildDatabaseSearchProbeSql).mockResolvedValue(null);
    await panelRef.value.startSearch();
    await vi.waitFor(() => {
      expect(states.at(-1)?.progressDone).toBe(2);
    });

    expect(api.buildDatabaseSearchSql).not.toHaveBeenCalled();
    expect(states.at(-1)?.results).toHaveLength(0);
  });

  it("first search scans past the 200-table batch boundary without user action", async () => {
    connectionConfig.db_type = "sqlite";
    const tables = Array.from({ length: 205 }, (_, index) => ({ name: `T${index}`, table_type: "TABLE" }));
    vi.mocked(api.getColumns).mockResolvedValue([] as any);
    vi.mocked(api.buildDatabaseSearchSql).mockResolvedValue(null as any);

    const { panelRef, states } = await mountPanel();
    vi.mocked(api.listTables).mockResolvedValue(tables as any);
    await panelRef.value.startSearch();
    await vi.waitFor(
      () => {
        expect(states.at(-1)?.progressDone).toBe(205);
      },
      { timeout: 5000 },
    );

    // 首轮自动跨过 200 张的批边界,无需点击“继续扫描/扫描剩余”
    expect(Math.max(...states.map((state) => state.progressDone ?? 0))).toBe(205);
    expect(api.getColumns).toHaveBeenCalledTimes(205);
    expect(states.at(-1)?.nextTableIndex).toBe(205);
    expect(states.at(-1)?.progressTotal).toBe(205);
  });
});
