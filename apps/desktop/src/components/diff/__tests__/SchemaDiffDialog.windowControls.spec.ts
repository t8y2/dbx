// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SchemaDiffDialog from "@/components/diff/SchemaDiffDialog.vue";
import { startSchemaDiffSession, removeSchemaDiffSession } from "@/composables/useSchemaDiffSession";
import type { OracleRoutineKind, OracleRoutineOperation, OracleRoutinePlanInput, OracleRoutineSnapshot } from "@/types/schemaDiff";

const calls = vi.hoisted(() => ({
  load: vi.fn(),
  compare: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  observe: vi.fn(),
  genericPlan: vi.fn(),
  confirm: vi.fn(),
  copy: vi.fn(),
  loadDdl: vi.fn(),
  transaction: vi.fn(),
  multi: vi.fn(),
  minimize: vi.fn(),
  databaseType: "oceanbase-oracle",
  sourceDatabaseType: "",
  targetConfig: { host: "localhost", is_production: true },
  ddlSettings: { theme: "default", fontSize: 12, fontFamily: "monospace", customThemes: [], activeCustomThemeId: "", includeDdlStorage: false, compactDdlSql: true, separateDdlIndexes: false },
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
// Only the runtime/platform predicates are substituted, so the dialog still runs the
// production `shouldShowWindowControls` and the real minimize binding.
const platform = vi.hoisted(() => ({ isMac: false, isDesktop: true }));
vi.mock("@/lib/backend/platform", () => ({ isMacOS: () => platform.isMac }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => platform.isDesktop }));
vi.mock("@/composables/useWindowControls", async (importOriginal) => ({ ...(await importOriginal<object>()), minimizeCurrentWindow: calls.minimize }));
vi.mock("@/composables/useDialogSources", () => ({ openSchemaDiffSession: vi.fn() }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => ({ addSchemaDiffTask: vi.fn(), updateCompareTask: vi.fn() }) }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: calls.confirm }) }));
vi.mock("@/stores/connectionStore", () => {
  const connections = () => ["source", "target"].map((id) => ({ id, name: id, db_type: id === "source" ? calls.sourceDatabaseType || calls.databaseType : calls.databaseType, is_production: id === "target", host: "localhost", port: 1, ...(id === "target" ? calls.targetConfig : {}) }));
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
vi.mock("@/stores/settingsStore", async (original) => ({ ...(await original<object>()), useSettingsStore: () => ({ editorSettings: reactive(calls.ddlSettings), updateEditorSettings: (patch: object) => Object.assign(reactive(calls.ddlSettings), patch) }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: calls.copy }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn().mockResolvedValue(undefined), loadObjectDdl: calls.loadDdl }));
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
  executeMulti: calls.multi,
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
  const product = connectionId === "source" ? calls.sourceDatabaseType || calls.databaseType : calls.databaseType;
  return { endpoint: { connectionId, database: "tenant", schema: owner, databaseType: product === "oracle" ? "oracle" : "oceanbase-oracle", generation: 1 }, state: "complete", enumerationComplete: true, objects: [], issues: [] };
}
const sourceSql = 'CREATE OR REPLACE FUNCTION "F" RETURN NUMBER AS BEGIN RETURN 1; END';
const sourceFunction = { name: "F", function_type: "FUNCTION", definition: sourceSql, arguments: "", data_type: "NUMBER" };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(platform, { isMac: false, isDesktop: true });
  records.clear();
  calls.databaseType = "oceanbase-oracle";
  calls.sourceDatabaseType = "";
  Object.assign(calls.targetConfig, { host: "localhost", is_production: true });
  Object.assign(calls.ddlSettings, { includeDdlStorage: false, compactDdlSql: true, separateDdlIndexes: false });
  calls.load.mockImplementation(async (id: string) => snapshot(id));
  calls.loadDdl.mockReset().mockResolvedValue({ ddl: 'CREATE TABLE "Source"."T" ("ID" NUMBER);' });
  calls.compare.mockResolvedValue({ diffs: [], functionDiffs: [{ type: "added", name: "F", source: sourceFunction }], syncSql: "", renameCandidates: [] });
  calls.confirm.mockResolvedValue(true);
  calls.genericPlan.mockResolvedValue({ syncSql: "CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE SQL;", rollbackCompleteness: "complete", missingRollbackObjects: [] });
  calls.transaction.mockResolvedValue({ status: "committed", executed_count: 1, statement_count: 1 });
  calls.multi.mockResolvedValue([]);
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
async function mountComparison(databaseType: "oracle" | "oceanbase-oracle" | "postgres" | "mysql" | "sqlserver" = "oceanbase-oracle", sourceType = databaseType, kinds?: OracleRoutineKind[], tables = false) {
  calls.databaseType = databaseType;
  calls.sourceDatabaseType = sourceType;
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: "source",
      sourceDatabase: "tenant",
      sourceSchema: "Source",
      sourceDbType: sourceType,
      targetConnectionId: "target",
      targetDatabase: "tenant",
      targetSchema: "Target",
      targetDbType: databaseType,
      options: { tables, views: false, functions: !tables, sequences: false, rules: false, owners: false, ...(kinds ? { routineObjectKinds: kinds } : {}) },
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
  localStorage.removeItem("dbx-schema-diff-size");
});
describe("schema diff window controls", () => {
  it("renders and invokes the native minimize control on desktop", async () => {
    await mountComparison();
    const minimize = document.querySelector<HTMLButtonElement>('button[aria-label="tabs.minimizeWindow"]');
    expect(minimize).not.toBeNull();
    minimize!.click();
    expect(calls.minimize).toHaveBeenCalledOnce();
  });

  it.each([
    ["macOS", { isMac: true, isDesktop: true }],
    ["the web build", { isMac: false, isDesktop: false }],
  ])("hides the minimize control on %s, where the window chrome is not drawn by the app", async (_runtime, flags) => {
    Object.assign(platform, flags);
    await mountComparison();
    expect(document.querySelector('button[aria-label="tabs.minimizeWindow"]')).toBeNull();
  });
});
