// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, DatabaseType, ObjectSourceKind } from "@/types/database";
import type { OracleRoutineOperation } from "@/types/schemaDiff";
import ObjectSourceDialog from "../ObjectSourceDialog.vue";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";

const ddl = 'CREATE SEQUENCE "APP"."SEQ" START WITH 40 INCREMENT BY 1 NOCACHE;';
const alter = 'ALTER SEQUENCE "APP"."SEQ" INCREMENT BY 1 NOCACHE;';
const mocks = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  buildExecutableObjectSourceStatements: vi.fn(),
  executeQuery: vi.fn(),
  checkConnectionHealth: vi.fn(),
  subscribeConnectionLiveness: vi.fn(),
  subscribeConnectionIdleClosed: vi.fn(),
  prewarmConnection: vi.fn(),
  loadConnections: vi.fn(),
  loadTunnelProfiles: vi.fn(),
  loadTableVGroups: vi.fn(),
  loadSidebarLayout: vi.fn(),
  listInstalledAgents: vi.fn(),
  prepareOracleRoutineSave: vi.fn(),
  updateOracleRoutineOperationReferences: vi.fn(async () => {}),
  executeOracleRoutineOperation: vi.fn(),
  observeOracleRoutineOperation: vi.fn(),
}));
// The Rust/backend boundary is mocked; the dialog, CodeMirror editor and shared
// save/production-guard pipeline remain real. Rust builder tests cover the SQL.
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), ...mocks }));
const cleanups: Array<() => void> = [];
const unexpectedHttp: string[] = [];
beforeEach(() => {
  unexpectedHttp.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    unexpectedHttp.push(String(input));
    throw new Error(`Unexpected HTTP boundary: ${String(input)}`);
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  expect(unexpectedHttp).toEqual([]);
});
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text);
}
function editor() {
  const root = document.querySelector<HTMLElement>('[role="dialog"] .cm-editor');
  return root ? EditorView.findFromDOM(root) : null;
}
async function mount(options: { databaseType?: DatabaseType; initialEditing?: boolean; editable?: boolean; type?: ObjectSourceKind; source?: string; production?: boolean } = {}) {
  const databaseType = options.databaseType ?? "oceanbase-oracle",
    objectType = options.type ?? "SEQUENCE",
    source = options.source ?? ddl;
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections.push({ id: "ob", name: "test", db_type: databaseType, is_production: options.production } as ConnectionConfig);
  store.connectedIds.add("ob");
  mocks.checkConnectionHealth.mockResolvedValue(undefined);
  mocks.subscribeConnectionLiveness.mockResolvedValue(() => {});
  mocks.subscribeConnectionIdleClosed.mockResolvedValue(() => {});
  mocks.prewarmConnection.mockResolvedValue(undefined);
  mocks.loadConnections.mockResolvedValue([]);
  mocks.loadTunnelProfiles.mockResolvedValue([]);
  mocks.loadTableVGroups.mockResolvedValue({});
  mocks.loadSidebarLayout.mockResolvedValue(null);
  mocks.listInstalledAgents.mockResolvedValue([]);
  mocks.getObjectSource.mockResolvedValue({ name: "SEQ", schema: "APP", object_type: objectType, source, editable: options.editable !== false });
  mocks.buildEditableObjectSource.mockResolvedValue(objectType === "SEQUENCE" && databaseType === "oceanbase-oracle" ? alter : source);
  mocks.buildExecutableObjectSourceStatements.mockResolvedValue([objectType === "SEQUENCE" ? alter : source]);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [], affected_rows: 0 });
  const saved = vi.fn();
  const state = reactive({ open: true, connectionId: "ob", database: "service", schema: "APP", name: "SEQ" });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(ObjectSourceDialog, { ...state, objectType, databaseType, dialect: "mysql", formatDialect: "plsql", initialEditing: options.initialEditing ?? false, onSaved: saved }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(editor()).not.toBeNull(), { timeout: 10_000 });
  return { saved, state };
}

describe("OceanBase sequence source through the shared Oracle object dialog", () => {
  it.each(["TYPE", "TYPE_BODY"] as const)("labels %s editing and save preview for the controlled TYPE flow", async (type) => {
    const source = type === "TYPE" ? 'CREATE OR REPLACE TYPE "APP"."SEQ" AS OBJECT (ID NUMBER);' : 'CREATE OR REPLACE TYPE BODY "APP"."SEQ" AS MEMBER FUNCTION F RETURN NUMBER IS BEGIN RETURN 1; END; END;';
    await mount({ type, source });
    expect(editor()!.state.readOnly).toBe(true);
    expect(button("contextMenu.editView")).toBeUndefined();
    button("contextMenu.editObject")!.click();
    await vi.waitFor(() => expect(editor()!.state.readOnly).toBe(false));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("contextMenu.editObject - SEQ");
    expect(button("objects.saveSource")).toBeUndefined();
    const requests = await import("@/lib/table/oracleTypeManagementRequest");
    try {
      button("objects.typeManagementPreviewSave")!.click();
      await vi.waitFor(() => expect(requests.oracleTypeManagementRequest.value?.operation).toBe(type === "TYPE_BODY" ? "save-body" : "save-spec"));
      expect(mocks.buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
      expect(mocks.executeQuery).not.toHaveBeenCalled();
    } finally {
      const pending = requests.oracleTypeManagementRequest.value;
      if (pending) requests.finishOracleTypeManagementRequest(pending.id, { complete: false, target: pending.target, operation: pending.operation });
    }
  });

  function routineOperation(source: string, valid: boolean): OracleRoutineOperation {
    const identity = { owner: "APP", name: "SEQ", kind: "FUNCTION" as const };
    return {
      operationId: "dialog-save-operation",
      target: { connectionId: "ob", database: "service", schema: "APP", databaseType: "oceanbase-oracle", generation: 0 },
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      readback: { identity, state: valid ? "verified" : "invalid", exists: true, version: null, source, definitionMatches: true, compilerMessages: valid ? [] : [{ attribute: "ERROR", line: 2, position: 17, text: "missing identifier" }], issues: [] },
      error: null,
    };
  }
  it("retains the routine editor and compiler position when acknowledged DDL is INVALID", async () => {
    const source = 'CREATE OR REPLACE FUNCTION "APP"."SEQ" RETURN NUMBER AS BEGIN RETURN missing_value; END;';
    const { saved } = await mount({ type: "FUNCTION", source, initialEditing: true });
    const operation = routineOperation(source, false);
    mocks.prepareOracleRoutineSave.mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    mocks.executeOracleRoutineOperation.mockResolvedValue(operation);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("ERROR 2:17 missing identifier"));
    expect(mocks.prepareOracleRoutineSave).toHaveBeenCalledWith({ connectionId: "ob", database: "service", identity: operation.identity, sql: source });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
    expect(editor()!.state.doc.toString()).toBe(source);
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(false);
  });
  it("reloads a routine only after the shared operation has verified the final definition", async () => {
    const source = 'CREATE OR REPLACE FUNCTION "APP"."SEQ" RETURN NUMBER AS BEGIN RETURN 1; END;';
    const { saved } = await mount({ type: "FUNCTION", source, initialEditing: true });
    const operation = routineOperation(source, true);
    mocks.prepareOracleRoutineSave.mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    mocks.executeOracleRoutineOperation.mockResolvedValue(operation);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith(operation.operationId, source);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(2));
  });
  it("prepares a routine before production confirmation but does not write after cancellation", async () => {
    const source = 'CREATE OR REPLACE FUNCTION "APP"."SEQ" RETURN NUMBER AS BEGIN RETURN 2; END;';
    const { saved } = await mount({ type: "FUNCTION", source, initialEditing: true, production: true });
    const operation = routineOperation(source, true);
    mocks.prepareOracleRoutineSave.mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    button("objects.saveSource")!.click();
    const safety = useProductionSafetyStore();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    expect(mocks.prepareOracleRoutineSave).toHaveBeenCalledOnce();
    safety.cancel();
    await vi.waitFor(() => expect(button("objects.saveSource")!.disabled).toBe(false));
    expect(mocks.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(editor()!.state.doc.toString()).toBe(source);
  });
  it("rechecks identity after the real production confirmation waits", async () => {
    const source = 'CREATE OR REPLACE VIEW "APP"."SEQ" AS SELECT 3 FROM DUAL';
    const { saved } = await mount({ type: "VIEW", source, initialEditing: true, production: true });
    const safety = useProductionSafetyStore();
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    const migration = freezeSourceIdentities([{ connectionId: "ob", database: "service", schema: "APP", objectType: "VIEW", name: "SEQ" }]);
    migration.markDispatched();
    migration.finish();
    safety.confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain("reload"));
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(editor()!.state.doc.toString()).toBe(source);
  });
  it("blocks migration while a real save is in flight and releases it afterwards", async () => {
    const source = 'CREATE OR REPLACE VIEW "APP"."SEQ" AS SELECT 4 FROM DUAL';
    const { saved } = await mount({ type: "VIEW", source, initialEditing: true });
    let complete!: (value: unknown) => void;
    mocks.executeQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledOnce());
    const identity = { connectionId: "ob", database: "service", schema: "APP", objectType: "VIEW", name: "SEQ" };
    expect(() => freezeSourceIdentities([identity])).toThrow("saved");
    complete({ columns: [], rows: [], affected_rows: 0 });
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const migration = freezeSourceIdentities([identity]);
    migration.cancel();
  });
  it("keeps the draft and refuses a late save after its view is renamed", async () => {
    const source = 'CREATE OR REPLACE VIEW "APP"."SEQ" AS SELECT 1 FROM DUAL';
    const { saved } = await mount({ type: "VIEW", source, initialEditing: true });
    let complete!: (value: string[]) => void;
    mocks.buildExecutableObjectSourceStatements.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
    );
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(mocks.buildExecutableObjectSourceStatements).toHaveBeenCalledOnce());
    const migration = freezeSourceIdentities([{ connectionId: "ob", database: "service", schema: "APP", objectType: "VIEW", name: "SEQ" }]);
    migration.markDispatched();
    migration.finish();
    complete([source]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(editor()!.state.doc.toString()).toBe(source);
    expect(document.body.textContent).toContain("reload");
  });
  it("previews the CREATE DDL read-only and switches to the backend ALTER draft only on edit", async () => {
    await mount();
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(editor()!.state.doc.toString()).toMatch(/CREATE\s+SEQUENCE/i);
    expect(editor()!.state.doc.toString()).toMatch(/START\s+WITH\s+40/i);
    expect(mocks.buildEditableObjectSource).toHaveBeenCalledWith({ databaseType: "oceanbase-oracle", objectType: "SEQUENCE", schema: "APP", name: "SEQ", source: ddl });
    button("contextMenu.editObject")!.click();
    await vi.waitFor(() => expect(editor()!.state.facet(EditorState.readOnly)).toBe(false));
    expect(editor()!.state.doc.toString()).toBe(alter);
    expect(editor()!.state.doc.toString()).not.toContain("START WITH");
  });
  it("saves only the generated ALTER and reloads the original object", async () => {
    const { saved } = await mount({ initialEditing: true });
    expect(editor()!.state.doc.toString()).toBe(alter);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.buildExecutableObjectSourceStatements).toHaveBeenCalledWith({ databaseType: "oceanbase-oracle", objectType: "SEQUENCE", schema: "APP", name: "SEQ", source: alter });
    expect(mocks.executeQuery).toHaveBeenCalledExactlyOnceWith("ob", "service", alter, "APP");
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(editor()!.state.facet(EditorState.readOnly)).toBe(true));
  });
  it.each([false, true])("leaves native Oracle sequences read-only (initialEditing=%s)", async (initialEditing) => {
    await mount({ databaseType: "oracle", initialEditing });
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(editor()!.state.doc.toString()).toMatch(/CREATE\s+SEQUENCE/i);
    expect(button("contextMenu.editObject")).toBeUndefined();
    expect(button("objects.saveSource")).toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it("honors a driver-declared read-only OceanBase object", async () => {
    await mount({ editable: false, initialEditing: true });
    expect(editor()!.state.facet(EditorState.readOnly)).toBe(true);
    expect(button("contextMenu.editObject")).toBeUndefined();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
  it("does not execute a sequence save after the selected connection changes during SQL generation", async () => {
    const { saved, state } = await mount({ initialEditing: true });
    let complete!: (value: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      complete = resolve;
    });
    mocks.buildExecutableObjectSourceStatements.mockReturnValueOnce(pending);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(mocks.buildExecutableObjectSourceStatements).toHaveBeenCalledOnce());
    state.connectionId = "another-connection";
    await nextTick();
    complete([alter]);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
  it("keeps synonym replacement on the existing source editor path", async () => {
    const source = 'CREATE OR REPLACE SYNONYM "APP"."SEQ" FOR "APP"."TARGET";';
    const { saved } = await mount({ type: "SYNONYM", source, initialEditing: true });
    expect(editor()!.state.doc.toString()).toBe(source);
    button("objects.saveSource")!.click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.executeQuery).toHaveBeenCalledExactlyOnceWith("ob", "service", source, "APP");
  });
});
