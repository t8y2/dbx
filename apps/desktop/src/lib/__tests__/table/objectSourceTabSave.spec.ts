import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { saveObjectSourceTab } from "@/lib/table/objectSourceTabSave";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig } from "@/types/database";
import type { OracleRoutineOperation, OracleRoutineSaveInput } from "@/types/schemaDiff";

vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key, locale: { value: "en-US" } } } }));
vi.mock("@/lib/backend/api", () => ({
  buildExecutableObjectSourceStatements: vi.fn(),
  prepareOracleRoutineSave: vi.fn(),
  updateOracleRoutineOperationReferences: vi.fn(async () => {}),
  executeOracleRoutineOperation: vi.fn(),
  observeOracleRoutineOperation: vi.fn(),
  executeQuery: vi.fn(),
  saveOpenTabsState: vi.fn(async () => {}),
}));

function operation(input: OracleRoutineSaveInput): OracleRoutineOperation {
  return {
    operationId: `approval-${input.identity.name}`,
    target: { connectionId: input.connectionId, database: input.database, schema: input.identity.owner, databaseType: "oceanbase-oracle", generation: 0 },
    identity: input.identity,
    lifecycle: "terminal",
    dispatched: true,
    acknowledged: true,
    readback: { identity: input.identity, state: "verified", exists: true, source: input.sql, version: null, definitionMatches: true, compilerMessages: [], issues: [] },
    error: null,
  };
}

function openDraft(name: string, kind: "FUNCTION" | "PACKAGE" | "PACKAGE_BODY" = "FUNCTION") {
  const connection = { id: `source-tab-${name}`, name: "Routine target", db_type: "oceanbase-oracle", is_production: true } as ConnectionConfig;
  useConnectionStore().connections.push(connection);
  const queryStore = useQueryStore();
  const original = kind === "FUNCTION" ? `CREATE OR REPLACE FUNCTION "APP"."${name}" RETURN NUMBER AS BEGIN RETURN 1; END;` : `CREATE OR REPLACE ${kind.replaceAll("_", " ")} "APP"."${name}" AS g NUMBER := 1; END "${name}";`;
  const sql = original.replace("RETURN 1", "RETURN 2").replace(":= 1", ":= 2");
  const id = queryStore.openObjectSourceTab({ connectionId: connection.id, database: "ORCL", schema: "APP", title: name, sql: original, objectSource: { name, schema: "APP", objectType: kind } });
  queryStore.updateSql(id, sql);
  const tab = queryStore.tabs.find((tab) => tab.id === id)!;
  const toast = vi.fn();
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? `:${values.message}` : ""}`;
  return { connection, queryStore, tab, sql, original, toast, save: () => saveObjectSourceTab(tab, { connection, queryStore, t, toast }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
  vi.mocked(api.buildExecutableObjectSourceStatements).mockImplementation(async ({ source }) => [source]);
  vi.mocked(api.prepareOracleRoutineSave).mockImplementation(async (input) => ({ ...operation(input), lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null }));
  vi.mocked(api.executeOracleRoutineOperation).mockImplementation(async () => operation(vi.mocked(api.prepareOracleRoutineSave).mock.calls.at(-1)![0]));
});

describe("App object source tab Save handler", () => {
  it.each(["PACKAGE", "PACKAGE_BODY"] as const)("prepares %s before confirmation and saves only its approved draft", async (kind) => {
    const draft = openDraft(`Confirmed${kind}`, kind);
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toMatchObject({ sql: draft.sql }));
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledExactlyOnceWith({ connectionId: draft.connection.id, database: "ORCL", identity: { owner: "APP", name: draft.tab.objectSource!.name, kind }, sql: draft.sql });
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    safety.confirm();
    await expect(pending).resolves.toBe(true);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith(`approval-Confirmed${kind}`, draft.sql);
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(false);
  });

  it("waits for real production confirmation, then saves exactly the approved ID and SQL and marks the draft clean", async () => {
    const draft = openDraft("Confirmed");
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toMatchObject({ connectionName: draft.connection.name, database: "ORCL", sql: draft.sql, source: "production.sourceObjectSource" }));
    expect(api.prepareOracleRoutineSave).toHaveBeenCalledExactlyOnceWith({ connectionId: draft.connection.id, database: "ORCL", identity: { owner: "APP", name: "Confirmed", kind: "FUNCTION" }, sql: draft.sql });
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(true);
    safety.confirm();
    await expect(pending).resolves.toBe(true);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith("approval-Confirmed", draft.sql);
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(false);
    expect(draft.toast).toHaveBeenCalledWith("objects.sourceSaved", 2000);
  });

  it("cancel preserves the actual dirty tab and dispatches nothing", async () => {
    const draft = openDraft("Canceled");
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    safety.cancel();
    await expect(pending).resolves.toBe(false);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(draft.tab.sql).toBe(draft.sql);
    expect(draft.tab.originalSql).toBe(draft.original);
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(true);
    expect(draft.toast).not.toHaveBeenCalled();
  });

  it("a target switch during confirmation prevents dispatch", async () => {
    const draft = openDraft("Retargeted");
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    draft.queryStore.updateDatabase(draft.tab.id, "OTHER");
    safety.confirm();
    await expect(pending).resolves.toBe(false);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(true);
  });

  it("does not mark a newer draft clean when the approved original finishes", async () => {
    const draft = openDraft("EditedWhileConfirming");
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    const newer = draft.sql.replace("RETURN 2", "RETURN 3");
    draft.queryStore.updateSql(draft.tab.id, newer);
    safety.confirm();
    await expect(pending).resolves.toBe(true);
    expect(api.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith("approval-EditedWhileConfirming", draft.sql);
    expect(draft.tab.sql).toBe(newer);
    expect(draft.tab.originalSql).toBe(draft.original);
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(true);
  });

  it.each(["FUNCTION", "PACKAGE", "PACKAGE_BODY"] as const)("INVALID %s readback retains the actual dirty tab and compiler location", async (kind) => {
    const draft = openDraft(`InvalidReadback${kind}`, kind);
    vi.mocked(api.executeOracleRoutineOperation).mockImplementationOnce(async () => {
      const result = operation(vi.mocked(api.prepareOracleRoutineSave).mock.calls.at(-1)![0]);
      result.readback!.state = "invalid";
      result.readback!.compilerMessages = [{ attribute: "ERROR", line: 3, position: 12, text: "missing identifier" }];
      return result;
    });
    const pending = draft.save();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await expect(pending).resolves.toBe(false);
    expect(draft.tab.sql).toBe(draft.sql);
    expect(draft.queryStore.isTabDirty(draft.tab)).toBe(true);
    expect(draft.toast).toHaveBeenCalledWith(expect.stringContaining("ERROR 3:12 missing identifier"), 5000);
    expect(draft.toast).not.toHaveBeenCalledWith("objects.sourceSaved", 2000);
  });

  it("preserves backend object-message errors", async () => {
    const draft = openDraft("BackendMessage");
    vi.mocked(api.buildExecutableObjectSourceStatements).mockRejectedValueOnce({ message: "Source validation failed" });
    await expect(draft.save()).resolves.toBe(false);
    expect(draft.toast).toHaveBeenCalledWith("objects.sourceSaveFailed:Source validation failed", 5000);
    expect(api.executeOracleRoutineOperation).not.toHaveBeenCalled();
  });
});
