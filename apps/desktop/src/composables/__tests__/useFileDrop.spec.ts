// @vitest-environment happy-dom

import { createApp, defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectionStore: {
    activeConnectionId: null as string | null,
    connections: [] as Array<{ id: string; db_type: string }>,
    getConfig: vi.fn(),
  },
  queryStore: {
    tabs: [] as Array<{ id: string; connectionId: string; database: string; catalog?: string; schema?: string }>,
    activeTabId: null as string | null,
    createTab: vi.fn(() => "opened-tab"),
    updateSql: vi.fn(),
    openExternalSqlFile: vi.fn(),
  },
  readBrowserSqlFile: vi.fn(async () => "select 1"),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.connectionStore }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks.queryStore }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { externalSqlEditorMaxMb: 64 } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useLargeSqlFileFallback", () => ({ useLargeSqlFileStreamingFallback: () => ({ openInStreamingExecutorOnTooLarge: vi.fn(() => false) }) }));
vi.mock("@/lib/sql/sqlFileOpen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sql/sqlFileOpen")>()),
  readBrowserSqlFile: mocks.readBrowserSqlFile,
}));

import { useFileDrop } from "@/composables/useFileDrop";

let app: ReturnType<typeof createApp> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectionStore.activeConnectionId = null;
  mocks.connectionStore.connections = [];
  mocks.connectionStore.getConfig.mockReset();
  mocks.queryStore.tabs = [];
  mocks.queryStore.activeTabId = null;
  mocks.queryStore.createTab.mockReturnValue("opened-tab");
});

afterEach(() => {
  app?.unmount();
  app = undefined;
});

describe("useFileDrop SQL target", () => {
  it("uses only an active SQL tab for browser-dropped files", async () => {
    let setupFileDrop!: ReturnType<typeof useFileDrop>["setupFileDrop"];
    app = createApp(
      defineComponent({
        setup() {
          ({ setupFileDrop } = useFileDrop());
          return () => h("div");
        },
      }),
    );
    app.mount(document.createElement("div"));
    await setupFileDrop();

    mocks.queryStore.tabs = [{ id: "sql-tab", connectionId: "postgres-1", database: "analytics", catalog: "hive", schema: "reporting" }];
    mocks.queryStore.activeTabId = "sql-tab";
    mocks.connectionStore.getConfig.mockImplementation((connectionId: string) => (connectionId === "postgres-1" ? { id: connectionId, db_type: "postgres" } : undefined));
    dispatchSqlDrop("active.sql");

    await vi.waitFor(() => expect(mocks.queryStore.createTab).toHaveBeenCalledTimes(1));
    expect(mocks.queryStore.createTab).toHaveBeenNthCalledWith(1, "postgres-1", "analytics", "active.sql", "query", "reporting", undefined, "hive");

    mocks.queryStore.tabs = [{ id: "mq-tab", connectionId: "kafka-1", database: "invalid", schema: "invalid" }];
    mocks.queryStore.activeTabId = "mq-tab";
    mocks.connectionStore.getConfig.mockImplementation((connectionId: string) => (connectionId === "kafka-1" ? { id: connectionId, db_type: "mq" } : undefined));
    dispatchSqlDrop("non-sql.sql");

    await vi.waitFor(() => expect(mocks.queryStore.createTab).toHaveBeenCalledTimes(2));
    expect(mocks.queryStore.createTab).toHaveBeenNthCalledWith(2, "", "", "non-sql.sql", "query", undefined, undefined, undefined);
  });
});

function dispatchSqlDrop(name: string) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["select 1"], name)] } });
  document.dispatchEvent(event);
}
