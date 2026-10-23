// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SchemaDiffDialog from "@/components/diff/SchemaDiffDialog.vue";
import { startSchemaDiffSession, removeSchemaDiffSession } from "@/composables/useSchemaDiffSession";
import type { OracleRoutineOperation, OracleRoutinePlanInput, OracleRoutineSnapshot } from "@/types/schemaDiff";

const calls = vi.hoisted(() => ({ load: vi.fn(), compare: vi.fn(), prepare: vi.fn(), execute: vi.fn(), observe: vi.fn(), genericPlan: vi.fn(), confirm: vi.fn(), copy: vi.fn(), transaction: vi.fn(), databaseType: "oceanbase-oracle" }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useDialogSources", () => ({ openSchemaDiffSession: vi.fn() }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => ({ addSchemaDiffTask: vi.fn(), updateCompareTask: vi.fn() }) }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: calls.confirm }) }));
vi.mock("@/stores/connectionStore", () => {
  const connections = () => ["source", "target"].map((id) => ({ id, name: id, db_type: calls.databaseType, is_production: id === "target", host: "localhost", port: 1 }));
  return {
    useConnectionStore: () => ({
      get connections() {
        return connections();
      },
      getConfig: (id: string) => connections().find((connection) => connection.id === id),
      ensureConnected: vi.fn().mockResolvedValue(undefined),
    }),
  };
});
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: calls.copy }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  loadSchemaDiffRoutines: calls.load,
  prepareSchemaDiff: calls.compare,
  prepareOracleRoutinePlan: calls.prepare,
  updateOracleRoutineOperationReferences: vi.fn(async () => {}),
  executeOracleRoutineOperation: calls.execute,
  observeOracleRoutineOperation: calls.observe,
  generateSchemaSyncPlan: calls.genericPlan,
  executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
  listFunctions: vi.fn().mockResolvedValue([]),
  executeScriptWith2pc: calls.transaction,
}));

// Substitute only CodeMirror's DOM boundary. The production dialog, session,
// deployment controller, buttons and production guard run unchanged.
vi.mock("@codemirror/state", () => ({
  EditorState: { readOnly: { of: () => [] }, create: (config: any) => ({ ...config, doc: { toString: () => config.doc, length: config.doc.length } }) },
  Compartment: class {
    of() {
      return [];
    }
    reconfigure() {
      return [];
    }
  },
}));
vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static updateListener = { of: (callback: unknown) => callback };
    static scrollIntoView = () => ({});
    state: any;
    input: HTMLTextAreaElement;
    listener: any;
    constructor(config: any) {
      this.state = config.state;
      this.listener = config.state.extensions.find((extension: unknown) => typeof extension === "function");
      this.input = document.createElement("textarea");
      this.input.value = this.state.doc.toString();
      this.input.addEventListener("input", () => this.setText(this.input.value));
      config.parent.append(this.input);
    }
    setText(text: string) {
      this.state.doc = { toString: () => text, length: text.length };
      this.input.value = text;
      this.listener?.({ docChanged: true, state: this.state });
    }
    dispatch(change: any) {
      if (change.changes) this.setText(change.changes.insert);
    }
    focus() {
      this.input.focus();
    }
    destroy() {
      this.input.remove();
    }
  },
}));
vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));
vi.mock("codemirror", () => ({ basicSetup: [] }));

const apps: App[] = [];
const sessions: string[] = [];
const records = new Map<string, OracleRoutineOperation>();
function snapshot(connectionId: string): OracleRoutineSnapshot {
  const owner = connectionId === "source" ? "Source" : "Target";
  return { endpoint: { connectionId, database: "tenant", schema: owner, databaseType: calls.databaseType === "oracle" ? "oracle" : "oceanbase-oracle", generation: 1 }, state: "complete", enumerationComplete: true, objects: [], issues: [] };
}
const sourceSql = 'CREATE OR REPLACE FUNCTION "F" RETURN NUMBER AS BEGIN RETURN 1; END';
const sourceFunction = { name: "F", function_type: "FUNCTION", definition: sourceSql, arguments: "", data_type: "NUMBER" };

beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  calls.databaseType = "oceanbase-oracle";
  calls.load.mockImplementation(async (id: string) => snapshot(id));
  calls.compare.mockResolvedValue({ diffs: [], functionDiffs: [{ type: "added", name: "F", source: sourceFunction }], syncSql: "", renameCandidates: [] });
  calls.confirm.mockResolvedValue(true);
  calls.genericPlan.mockResolvedValue({ syncSql: "CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE SQL;", rollbackCompleteness: "complete", missingRollbackObjects: [] });
  calls.transaction.mockResolvedValue({ status: "committed", executed_count: 1, statement_count: 1 });
  calls.prepare.mockImplementation(async (input: OracleRoutinePlanInput) => ({
    target: input.target.endpoint,
    ready: true,
    steps: input.drafts.map((draft) => {
      const operation: OracleRoutineOperation = { operationId: `approval-${calls.prepare.mock.calls.length}`, target: input.target.endpoint, identity: draft.identity, lifecycle: "prepared", dispatched: false, acknowledged: false, error: null, readback: null };
      records.set(operation.operationId, operation);
      return {
        identity: draft.identity,
        action: draft.action,
        sql: draft.sql ?? 'CREATE FUNCTION "Target"."F" RETURN NUMBER AS BEGIN RETURN 1; END;',
        sourceOriginal: sourceSql,
        targetOriginal: null,
        recoverySql: null,
        recoveryComplete: true,
        references: [],
        incomingCallers: [],
        issues: [],
        operation,
      };
    }),
  }));
  calls.observe.mockImplementation(async (id: string) => ({ operation: records.get(id), lifecycle: records.get(id)?.lifecycle, error: null }));
  calls.execute.mockImplementation(async (id: string) => {
    const operation: OracleRoutineOperation = {
      ...records.get(id)!,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      readback: { identity: records.get(id)!.identity, state: "invalid", exists: true, version: null, source: sourceSql, definitionMatches: true, issues: [], compilerMessages: [{ attribute: "ERROR", line: 1, position: 20, text: "invalid identifier" }] },
    };
    records.set(id, operation);
    return operation;
  });
});

async function flush() {
  for (let index = 0; index < 8; index++) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
  expect(found, text).toBeDefined();
  return found!;
}
async function mountComparison(databaseType: "oracle" | "oceanbase-oracle" | "postgres" | "mysql" | "sqlserver" = "oceanbase-oracle") {
  calls.databaseType = databaseType;
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "tenant",
      sourceSchema: "Source",
      sourceDbType: databaseType,
      targetConnectionId: "target",
      targetDatabase: "tenant",
      targetSchema: "Target",
      targetDbType: databaseType,
      options: { tables: false, views: false, functions: true, sequences: false, rules: false, owners: false },
      ignoreComments: false,
      label: "test",
    },
    { tableListLoader: { load: vi.fn().mockResolvedValue([]) } },
  );
  sessions.push(session.id);
  await flush();
  expect(session.status).toBe("completed");
  const visible = reactive({ open: true });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () =>
      h(SchemaDiffDialog, {
        open: visible.open,
        sessionId: session.id,
        "onUpdate:open": (open: boolean) => {
          visible.open = open;
        },
      }),
  });
  apps.push(app);
  app.mount(host);
  await flush();
  return { session, visible };
}

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  sessions.splice(0).forEach(removeSchemaDiffSession);
  document.body.innerHTML = "";
});

it("opens the real Oracle comparison, retains draft on both confirmations' cancellation, then displays INVALID and corrects only that step", async () => {
  const { session } = await mountComparison();
  button("diff.nextStepDeployRoutines").click();
  await flush();
  expect(calls.genericPlan).not.toHaveBeenCalled();
  expect(session.routineDeployment?.plan?.ready).toBe(true);
  expect(button("diff.deployToServer").disabled).toBe(false);
  button("diff.deployToServer").click();
  await flush();
  const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "diff.cancel").at(-1)!;
  cancel.click();
  await flush();
  expect(calls.execute).not.toHaveBeenCalled();
  expect(session.routineDeployment?.drafts[0].sql).toContain('"Target"."F"');
  calls.confirm.mockResolvedValueOnce(false);
  button("diff.deployToServer").click();
  await flush();
  button("diff.confirmDeploy").click();
  await flush();
  expect(calls.confirm).toHaveBeenCalledTimes(1);
  expect(calls.execute).not.toHaveBeenCalled();
  button("diff.deployToServer").click();
  await flush();
  button("diff.confirmDeploy").click();
  await flush();
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("ERROR 1:20 — invalid identifier");
  expect(button("diff.deployToServer").disabled).toBe(true);
  const editor = document.querySelector<HTMLTextAreaElement>(".deploy-sql-editor textarea")!;
  editor.value = 'CREATE FUNCTION "Target"."F" RETURN NUMBER AS BEGIN RETURN 77; END;';
  editor.dispatchEvent(new Event("input"));
  await flush();
  button("diff.routineValidate").click();
  await flush();
  expect(calls.prepare.mock.calls.at(-1)![0].drafts[0]).toMatchObject({ action: "replace", baselineOperationId: "approval-1", sql: editor.value });
  expect(button("diff.deployToServer").disabled).toBe(false);
  calls.execute.mockImplementationOnce(async (id: string) => ({
    ...records.get(id)!,
    lifecycle: "terminal",
    dispatched: true,
    acknowledged: true,
    readback: { identity: records.get(id)!.identity, state: "verified", exists: true, version: null, source: editor.value, definitionMatches: true, compilerMessages: [], issues: [] },
  }));
  button("diff.deployToServer").click();
  await flush();
  button("diff.confirmDeploy").click();
  await flush();
  expect(calls.execute.mock.calls.map((call) => call[0])).toEqual(["approval-1", "approval-2"]);
  expect(session.routineDeployment?.records).toHaveLength(2);
  expect(document.body.textContent).toContain("diff.routineReadOnlyCompleted");
});

it("restores the same draft and operation after closing and reopening the actual dialog", async () => {
  const { session, visible } = await mountComparison();
  button("diff.nextStepDeployRoutines").click();
  await flush();
  const editor = document.querySelector<HTMLTextAreaElement>(".deploy-sql-editor textarea")!;
  editor.value = "retained manual draft";
  editor.dispatchEvent(new Event("input"));
  await flush();
  visible.open = false;
  await flush();
  visible.open = true;
  await flush();
  expect(document.querySelector<HTMLTextAreaElement>(".deploy-sql-editor textarea")?.value).toBe("retained manual draft");
  expect(session.routineDeployment?.records[0].operationId).toBe("approval-1");
  expect(calls.execute).not.toHaveBeenCalled();
});

it("retains a late unknown result across close/reopen and only observes its original request", async () => {
  const { session, visible } = await mountComparison();
  button("diff.nextStepDeployRoutines").click();
  await flush();
  let reject!: (error: Error) => void;
  calls.execute.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  button("diff.deployToServer").click();
  await flush();
  button("diff.confirmDeploy").click();
  await flush();
  expect(calls.execute).toHaveBeenCalledTimes(1);
  visible.open = false;
  await flush();
  const unknown = { ...records.get("approval-1")!, lifecycle: "unproven" as const, dispatched: true };
  records.set("approval-1", unknown);
  reject(new Error("client response lost"));
  await flush();
  visible.open = true;
  await flush();
  expect(session.routineDeployment?.drafts[0].operation?.operationId).toBe("approval-1");
  expect(button("diff.deployToServer").disabled).toBe(true);
  button("diff.routineObserve").click();
  await flush();
  expect(calls.observe).toHaveBeenLastCalledWith("approval-1", true);
  button("diff.routineValidate").click();
  await flush();
  expect(calls.prepare).toHaveBeenCalledTimes(1);
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("termination is not proven");
});

it("retains all four comparison states and copies an equal object's exact raw source", async () => {
  const raw = sourceSql.replace("RETURN 1", "RETURN 'two  spaces'");
  calls.compare.mockResolvedValue({
    diffs: [],
    syncSql: "",
    functionDiffs: [
      { type: "added", name: "Added", source: { ...sourceFunction, name: "Added" } },
      { type: "modified", name: "Modified", source: { ...sourceFunction, name: "Modified" }, target: { ...sourceFunction, name: "Modified", definition: "old" } },
      { type: "removed", name: "Removed", target: { ...sourceFunction, name: "Removed" } },
      { type: "equal", name: "Equal", source: { ...sourceFunction, name: "Equal", definition: raw }, target: { ...sourceFunction, name: "Equal", definition: raw } },
    ],
  });
  await mountComparison();
  const rows = [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter((row) => row.querySelector('input[type="checkbox"]'));
  expect(rows).toHaveLength(4);
  const equal = rows.find((row) => row.textContent?.includes("Equal"))!;
  expect(equal.textContent).toContain("diff.routineEqual");
  expect(equal.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  equal.click();
  await flush();
  const copy = document.querySelector<HTMLButtonElement>('button[title="diff.copySourceDdl"]')!;
  expect(copy.disabled).toBe(false);
  copy.click();
  expect(calls.copy).toHaveBeenLastCalledWith(raw);
});

it.each(["mysql", "sqlserver"] as const)("keeps %s routine comparison copy-only", async (databaseType) => {
  await mountComparison(databaseType);
  expect(document.body.textContent).toContain("diff.routineSyncDeferredHint");
  expect(document.body.textContent).not.toContain("diff.nextStepDeployRoutines");
  expect(calls.prepare).not.toHaveBeenCalled();
  expect(calls.execute).not.toHaveBeenCalled();
});

it("keeps PostgreSQL's existing plan, confirmation and transactional execution path", async () => {
  await mountComparison("postgres");
  button("diff.nextStepDeployRoutines").click();
  await flush();
  expect(calls.genericPlan).toHaveBeenCalled();
  expect(calls.prepare).not.toHaveBeenCalled();
  button("diff.deployToServer").click();
  await flush();
  button("diff.confirmDeploy").click();
  await flush();
  expect(calls.transaction).toHaveBeenCalledWith("target", "tenant", ["CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE SQL;"], "Target", false);
  expect(document.body.textContent).toContain("diff.deploySuccessMessage");
  expect(calls.execute).not.toHaveBeenCalled();
});

it("does not label two failed inventories as an equal empty comparison", async () => {
  calls.load.mockImplementation(async (id: string) => ({ ...snapshot(id), state: "permission-denied", enumerationComplete: false, issues: [{ stage: "inventory", code: "permission-denied", message: "Metadata visibility unavailable" }] }));
  calls.compare.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  await mountComparison();
  expect(document.body.textContent).toContain("Metadata visibility unavailable");
  expect(document.body.textContent).toContain("diff.routineUnreadable");
  expect(document.body.textContent).not.toContain("diff.noDifferences");
  expect(button("diff.nextStepDeployRoutines").disabled).toBe(true);
});

it("opens a native Oracle target draft through the same controlled review", async () => {
  const { session } = await mountComparison("oracle");
  button("diff.nextStepDeployRoutines").click();
  await flush();
  expect(session.routineDeployment?.plan?.target.databaseType).toBe("oracle");
  expect(button("diff.deployToServer").disabled).toBe(false);
  expect(calls.genericPlan).not.toHaveBeenCalled();
});
