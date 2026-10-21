import { computed, ref } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { serializeOpenTabs, restoreOpenTabsState } from "@/lib/app/openTabsPersistence";
import type { TabOutputView } from "@/types/database";

const backend = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(async (input: { source: string }) => input.source),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  prepareQueryPaginationExecutionPlan: vi.fn(async (input: { sql: string }) => ({ sqlToExecute: input.sql })),
  checkConnectionHealth: vi.fn(async () => undefined),
  saveOpenTabsState: vi.fn(async () => {}),
  saveHistory: vi.fn(async () => {}),
  saveEditorSettings: vi.fn(async () => {}),
  closeQuerySession: vi.fn(async () => {}),
  closeClientConnectionSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));
let pinia: Pinia;
const options = { connectionId: "oracle-1", database: "ORCL", schema: "APP", catalog: "CAT", title: "Source - P", request: { name: "P", objectType: "PROCEDURE" as const } };
beforeEach(() => {
  vi.clearAllMocks();
  backend.getObjectSource.mockReset();
  pinia = createPinia();
  setActivePinia(pinia);
  const connections = useConnectionStore();
  connections.connections = [{ id: "oracle-1", name: "oracle", db_type: "oracle", host: "localhost", port: 1521, username: "test", password: "" }];
  connections.connectedIds.add("oracle-1");
  backend.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 });
  backend.executeMulti.mockResolvedValue([{ columns: ["N"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]);
});
afterEach(() => {
  disposePinia(pinia);
  setActivePinia(undefined);
});

describe("object detail identity through the real source store", () => {
  it("keeps read-only identity after sourceLoad is cleared, and persists only identity and section", async () => {
    backend.getObjectSource.mockResolvedValue({ name: "P", object_type: "PROCEDURE", source: "read-only definition", editable: false });
    const store = useQueryStore();
    const id = store.openObjectSourceTabPending({ ...options, initialSection: "dependencies" });
    const tab = store.tabs.find((item) => item.id === id)!;
    expect(tab.objectDetails?.section).toBe("dependencies");
    await vi.waitFor(() => expect(tab.sourceLoad).toBeUndefined());
    expect(tab.objectSource).toBeUndefined();
    expect(tab.objectDetails).toEqual({ connectionId: "oracle-1", database: "ORCL", schema: "APP", catalog: "CAT", name: "P", objectType: "PROCEDURE", section: "dependencies" });
    const restored = restoreOpenTabsState(JSON.stringify(serializeOpenTabs([tab])), id).tabs[0]!;
    expect(restored.objectDetails).toEqual(tab.objectDetails);
    expect(restored.sourceLoad).toBeUndefined();
    expect(restored.result).toBeUndefined();
    store.duplicateTab(id);
    const duplicate = store.tabs.find((item) => item.id !== id)!;
    expect(duplicate.objectDetails).toEqual(tab.objectDetails);
    duplicate.objectDetails!.section = "source";
    expect(tab.objectDetails?.section).toBe("dependencies");
  });

  it("keeps a dirty resolved function when a procedure fallback merges into its tab", async () => {
    const store = useQueryStore();
    const id = store.openObjectSourceTab({ ...options, sql: "original", objectSource: { schema: "APP", name: "P", objectType: "FUNCTION" } });
    store.updateSql(id, "dirty function draft");
    backend.getObjectSource.mockImplementation(async (_connection, _database, _schema, _name, kind) => {
      return { name: "P", object_type: kind, source: kind === "PROCEDURE" ? "" : "fresh function source" };
    });
    store.openObjectSourceTabPending({ ...options, initialSection: "dependents" });
    await vi.waitFor(() => expect(store.tabs).toHaveLength(1));
    expect(store.tabs[0]?.id).toBe(id);
    expect(store.tabs[0]?.sql).toBe("dirty function draft");
    expect(store.tabs[0]?.objectDetails).toMatchObject({ objectType: "FUNCTION", section: "dependents" });
  });

  it("retains identity on source failure and deduplicates requests without losing the selected section", async () => {
    backend.getObjectSource.mockRejectedValue(new Error("source denied"));
    const store = useQueryStore();
    const id = store.openObjectSourceTabPending(options);
    await vi.waitFor(() => expect(store.tabs[0]?.sourceLoad?.error).toBeTruthy());
    expect(store.tabs[0]?.objectDetails?.section).toBe("source");
    expect(store.openObjectSourceTabPending({ ...options, initialSection: "dependents" })).toBe(id);
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]?.objectDetails?.section).toBe("dependents");
  });

  it("blocks new execution/explain while source is hidden and resumes the normal pipeline on return", async () => {
    const store = useQueryStore();
    const connections = useConnectionStore();
    const id = store.createTab("oracle-1", "ORCL", "Source - P", "query", "APP", "SELECT 1 FROM DUAL");
    const tab = store.tabs.find((item) => item.id === id)!;
    tab.objectDetails = { connectionId: tab.connectionId, database: tab.database, schema: "APP", name: "P", objectType: "PROCEDURE", section: "dependencies" };
    useSettingsStore().editorSettings.confirmDangerousSqlExecution = false;
    const execution = useSqlExecution({ activeTab: computed(() => tab), activeConnection: computed(() => connections.connections[0]), executableSql: computed(() => tab.sql), activeOutputView: ref<TabOutputView>("result") });
    expect(await execution.tryExecute()).toMatchObject({ status: "not-started", reason: "blocked" });
    expect(await execution.tryExecuteInNewResultTab()).toMatchObject({ status: "not-started", reason: "blocked" });
    await execution.tryExplain();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    expect(backend.executeMulti).not.toHaveBeenCalled();
    expect(tab.result).toBeUndefined();
    tab.objectDetails.section = "source";
    const outcome = await execution.tryExecute();
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "started", ok: true });
    expect(backend.executeMulti).toHaveBeenCalledWith("oracle-1", "ORCL", "SELECT 1 FROM DUAL", "APP", expect.any(String), expect.any(Object));
  });
});
