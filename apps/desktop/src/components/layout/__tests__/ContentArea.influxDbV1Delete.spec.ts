// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, ConnectionConfig, QueryResult, QueryTab } from "@/types/database";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { INFLUXDB_V1_FIELD_COLUMN_EXTRA, INFLUXDB_V1_TAG_COLUMN_EXTRA, INFLUXDB_V1_TIME_COLUMN_EXTRA } from "@/lib/influxdb/influxDbV1Delete";

const mocks = vi.hoisted(() => ({ executeQuery: vi.fn(), handler: undefined as unknown }));

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGridColumnLayoutPopover.vue", () => ({ default: { render: () => null } }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), executeQuery: mocks.executeQuery }));
vi.mock("@/components/grid/DataGrid.vue", () => ({
  __esModule: true,
  default: defineComponent({
    name: "DataGridStub",
    props: {
      editable: Boolean,
      customSaveHandler: Object,
      result: Object,
    },
    setup(props) {
      return () => {
        const handler = props.customSaveHandler as CustomSaveHandler | undefined;
        mocks.handler = handler;
        const result = props.result as QueryResult;
        return h("div", {
          "data-test": "data-grid",
          "data-editable": String(props.editable),
          "data-delete-handler": handler?.confirmation ?? "none",
          "data-can-update": String(handler?.canUpdate ?? false),
          "data-reload-on-failure": String(handler?.reloadOnFailure ?? false),
          "data-readonly-columns": handler?.readonlyColumns?.join(",") ?? "",
          "data-first-row-deletable": String(handler?.canDeleteRow?.(0, result.rows[0] ?? []) ?? false),
        });
      };
    },
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";

const mounted: Array<{ app: App<Element>; host: HTMLElement }> = [];

function column(name: string, extra: string, primary = false): ColumnInfo {
  return {
    name,
    data_type: extra === INFLUXDB_V1_TIME_COLUMN_EXTRA ? "timestamp" : "string",
    is_nullable: extra !== INFLUXDB_V1_TIME_COLUMN_EXTRA,
    column_default: null,
    is_primary_key: primary,
    extra,
  };
}

function connection(db_type: ConnectionConfig["db_type"], version?: string): ConnectionConfig {
  return {
    id: `connection-${db_type}-${version ?? "legacy"}`,
    name: "Influx test",
    db_type,
    host: "localhost",
    port: 8086,
    username: "",
    password: "",
    database: "metrics",
    external_config: version === undefined ? undefined : { version },
  };
}

function dataTab(connectionId: string, options: { tagValue?: string | null; metadataRole?: string } = {}): QueryTab {
  const columns = [column("time", INFLUXDB_V1_TIME_COLUMN_EXTRA, true), column("host", options.metadataRole ?? INFLUXDB_V1_TAG_COLUMN_EXTRA, true), column("usage", INFLUXDB_V1_FIELD_COLUMN_EXTRA)];
  return {
    id: "data-cpu",
    title: "cpu",
    connectionId,
    database: "metrics",
    mode: "data",
    sql: "cpu",
    isExecuting: false,
    result: {
      columns: ["time", "host", "usage"],
      rows: [["2026-09-27T10:11:12Z", options.tagValue === undefined ? "web01" : options.tagValue, 42]],
      affected_rows: 1,
      execution_time_ms: 1,
    },
    tableMeta: { tableName: "cpu", columns, primaryKeys: ["time", "host"] },
  };
}

async function mount(connectionConfig: ConnectionConfig, tab = dataTab(connectionConfig.id)) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connectionConfig];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ContentArea, {
          activeTab: tab,
          activeConnection: connectionConfig,
          activeOutputView: "result",
          executableSql: "",
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          blockDangerousRedisCommands: false,
        }),
    }),
  );
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const grid = host.querySelector<HTMLElement>('[data-test="data-grid"]');
  expect(grid).not.toBeNull();
  return grid!;
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  mocks.executeQuery.mockReset();
  mocks.handler = undefined;
  localStorage.clear();
});

describe("ContentArea InfluxDB 1.x delete gating", () => {
  it("enables only the delete handler while keeping every value column read-only", async () => {
    const grid = await mount(connection("influxdb", "1"));

    expect(grid.dataset.editable).toBe("true");
    expect(grid.dataset.deleteHandler).toBe("influxdb-v1-delete");
    expect(grid.dataset.canUpdate).toBe("false");
    expect(grid.dataset.reloadOnFailure).toBe("true");
    expect(grid.dataset.readonlyColumns).toBe("time,host,usage");
    expect(grid.dataset.firstRowDeletable).toBe("true");
  });

  it("executes the guarded preview verbatim and propagates backend failures", async () => {
    const config = connection("influxdb", "1");
    await mount(config);
    const handler = mocks.handler as CustomSaveHandler;
    const changes = {
      dirtyRows: new Map(),
      newRows: [],
      newRowMeta: [],
      deletedRows: new Set([0]),
      columns: ["time", "host", "usage"],
      rows: [["2026-09-27T10:11:12Z", "web01", 42]],
    };
    const statements = await handler.preview!(changes);
    mocks.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });

    await handler.save(changes);

    expect(mocks.executeQuery).toHaveBeenCalledWith(config.id, "metrics", statements[0]);

    mocks.executeQuery.mockRejectedValueOnce(new Error("InfluxDB rejected the delete"));
    await expect(handler.save(changes)).rejects.toThrow("InfluxDB rejected the delete");
  });

  it("keeps a row with a missing tag unavailable for deletion", async () => {
    const config = connection("influxdb", "1");
    const grid = await mount(config, dataTab(config.id, { tagValue: null }));

    expect(grid.dataset.deleteHandler).toBe("influxdb-v1-delete");
    expect(grid.dataset.firstRowDeletable).toBe("false");
  });

  it.each([
    { dbType: "influxdb" as const, version: "2", metadataRole: INFLUXDB_V1_TAG_COLUMN_EXTRA, existingEditable: false },
    { dbType: "influxdb3" as const, version: "3", metadataRole: INFLUXDB_V1_TAG_COLUMN_EXTRA, existingEditable: true },
    { dbType: "influxdb" as const, version: "1", metadataRole: "", existingEditable: false },
  ])("does not add the delete path for an unsupported engine or metadata shape ($dbType/$version)", async ({ dbType, version, metadataRole, existingEditable }) => {
    const config = connection(dbType, version);
    const grid = await mount(config, dataTab(config.id, { metadataRole }));

    expect(grid.dataset.editable).toBe(String(existingEditable));
    expect(grid.dataset.deleteHandler).toBe("none");
    expect(grid.dataset.firstRowDeletable).toBe("false");
  });
});
