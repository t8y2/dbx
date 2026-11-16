// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { OracleRoutineOperation, OracleRoutinePlanInput, OracleRoutineSnapshot } from "@/types/schemaDiff";
import type { TransferRequest, TransferProgress, OraclePackageTransferPreview } from "@/lib/backend/api";
import type { TransferTask } from "@/types/database";

const calls = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn(), refs: vi.fn(), observe: vi.fn(), confirm: vi.fn(), cancelScope: vi.fn(), writable: vi.fn(), save: vi.fn(), toast: vi.fn(), load: vi.fn(), compare: vi.fn(), openComparison: vi.fn(), tables: vi.fn() }));
const savedTask = {
  id: "saved-package",
  name: "Package transfer",
  orderIndex: 0,
  createdAt: "",
  updatedAt: "",
  config: {
    sourceConnectionId: "source",
    sourceDatabase: "S",
    sourceSchema: "S",
    targetConnectionId: "target",
    targetDatabase: "T",
    targetSchema: "T",
    objects: { PACKAGE_BODY: ["P"] },
    content: "structureOnly",
    mode: "append",
    targetTableNameCase: "preserve",
    quoteTargetColumnNames: true,
    batchSize: 100,
  },
} as TransferTask;

vi.mock("@/lib/backend/api", () => ({
  previewTransferOwnership: calls.preview,
  startTransfer: calls.start,
  updateOracleRoutineOperationReferences: calls.refs,
  observeOracleRoutineOperation: calls.observe,
  listSchemas: vi.fn(async (id: string) => [id === "source" ? "S" : id === "replacement" ? "U" : "T"]),
  listTables: calls.tables,
  listObjects: vi.fn(async (_id: string, _db: string, _schema: string, kinds: string[]) => (kinds.some((kind) => kind === "PACKAGE" || kind === "PACKAGE_BODY") ? [{ name: "P" }] : [])),
  cancelTransfer: vi.fn(),
  loadSchemaDiffRoutines: calls.load,
  prepareSchemaDiff: calls.compare,
}));
vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "source", name: "Source", db_type: "oracle", database: "tenant" },
    { id: "target", name: "Target", db_type: "oceanbase-oracle", database: "tenant" },
    { id: "replacement", name: "Replacement", db_type: "oceanbase-oracle", database: "tenant" },
  ];
  return { useConnectionStore: () => ({ connections, sidebarLayout: { groups: [], order: [] }, getConfig: (id: string) => connections.find((config) => config.id === id), ensureConnected: async () => {}, refreshObjectListTreeNode: vi.fn() }) };
});
vi.mock("@/stores/transferTaskStore", () => ({
  useTransferTaskStore: () => ({ initFromStorage: async () => {}, getTask: (id: string) => (id === savedTask.id ? savedTask : undefined), listTasks: () => [savedTask], saveTask: calls.save }),
  TransferTaskNameConflictError: class extends Error {},
  nextTransferTaskCopyName: (name: string) => name,
}));
vi.mock("@/components/transfer/TransferTaskTree.vue", () => ({
  default: defineComponent({
    emits: ["select"],
    setup(_props, { emit }) {
      return () => h("button", { onClick: () => emit("select", savedTask) }, "Load saved package");
    },
  }),
}));
vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({
  default: defineComponent({
    props: ["modelValue", "connections"],
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "select",
          { "data-testid": "transfer-connection", value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) },
          props.connections.map((connection: { id: string }) => h("option", { value: connection.id }, connection.id)),
        );
    },
  }),
}));
vi.mock("@/composables/useDialogSources", () => ({ openDataTransferTask: vi.fn(), openSchemaDiffSession: calls.openComparison }));
vi.mock("@/lib/database/readOnlyWriteAccess", () => ({ ensureReadOnlyWriteAccess: calls.writable }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: calls.confirm, cancelScope: calls.cancelScope }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: calls.toast }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (text: string) => text }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn() }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: async () => (sql: string) => sql.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") }));
vi.mock("@/lib/table/objectBrowserRowsCache", () => ({ invalidateObjectBrowserRowsCache: vi.fn() }));
vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static updateListener = { of: (listener: unknown) => ({ listener }) };
    static scrollIntoView = () => ({});
    state: any;
    input = document.createElement("textarea");
    constructor({ state, parent }: any) {
      this.state = state;
      this.input.dataset.testid = "package-editor";
      this.input.value = state.doc.toString();
      parent.append(this.input);
      this.input.addEventListener("input", () => {
        const text = this.input.value;
        this.state.doc = { toString: () => text, length: text.length };
        state.extensions.find((extension: any) => extension?.listener)?.listener({ docChanged: true, state: this.state });
      });
    }
    dispatch(update: any) {
      if (update.changes) {
        const text = update.changes.insert;
        this.state.doc = { toString: () => text, length: text.length };
        this.input.value = text;
      }
    }
    focus() {
      this.input.focus();
    }
    destroy() {
      this.input.remove();
    }
  },
}));
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
vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));
vi.mock("codemirror", () => ({ basicSetup: [] }));

import DataTransferDialog from "@/components/transfer/DataTransferDialog.vue";
import { useExportTracker } from "@/composables/useExportTracker";
import { getSchemaDiffSession, schemaDiffSessionObjects } from "@/composables/useSchemaDiffSession";

const apps: App[] = [];
const records = new Map<string, OracleRoutineOperation>();
const generated = 'CREATE PACKAGE BODY "T"."P" AS -- 原始😀\nEND;';
const corrected = generated.replace("原始", "人工复核");

beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  savedTask.config.objects = { PACKAGE_BODY: ["P"] };
  calls.tables.mockResolvedValue([]);
  i18n.global.locale.value = "en";
  calls.refs.mockResolvedValue(undefined);
  calls.writable.mockResolvedValue(true);
  calls.confirm.mockResolvedValue(true);
  calls.observe.mockImplementation(async (id: string) => ({ operation: records.get(id), lifecycle: records.get(id)?.lifecycle, error: null }));
  calls.preview.mockImplementation(async (request: TransferRequest) => {
    const snapshot = (source: boolean): OracleRoutineSnapshot => ({
      endpoint: { connectionId: source ? request.sourceConnectionId : request.targetConnectionId, database: source ? request.sourceDatabase : request.targetDatabase, schema: source ? request.sourceSchema : request.targetSchema, databaseType: source ? "oracle" : "oceanbase-oracle", generation: 1 },
      state: "complete",
      enumerationComplete: true,
      objects: [],
      issues: [],
    });
    const identity = { owner: request.targetSchema, name: "P", kind: "PACKAGE_BODY" as const };
    const input: OracleRoutinePlanInput = request.oraclePackages?.input ?? { source: snapshot(true), target: snapshot(false), drafts: [{ identity, sourceName: "P", action: "create" }] };
    const sql = input.drafts[0].sql ?? generated;
    const ready = input.drafts[0].sql === corrected;
    const operation: OracleRoutineOperation = { operationId: `original-body-${request.transferId}-${calls.preview.mock.calls.length}`, target: input.target.endpoint, identity, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null, error: null };
    if (ready) records.set(operation.operationId, operation);
    return {
      missingOwners: [],
      targetOwner: "T",
      structure: { sql, tables: [], operations: [], schemaObjectsExpanded: true },
      oraclePackages: {
        input,
        skipped: [],
        plan: {
          target: input.target.endpoint,
          ready,
          steps: [
            {
              identity,
              action: "create",
              sql,
              sourceOriginal: 'CREATE PACKAGE BODY "S"."P" AS -- 原始😀\nEND;',
              targetOriginal: null,
              recoverySql: null,
              recoveryComplete: true,
              references: [],
              incomingCallers: [],
              issues: ready ? [] : [{ code: "review-required", message: "Review the target draft", line: 1, column: 1 }],
              operation: ready ? operation : null,
            },
          ],
        },
      },
    };
  });
  calls.start.mockImplementation(async (request, progress, started) => {
    started?.();
    progress({ transferId: request.transferId, table: "", tableIndex: 0, totalTables: 0, rowsTransferred: 0, totalRows: null, status: "done", terminal: true, error: null });
  });
  calls.load.mockImplementation(async (id: string, database: string, schema: string): Promise<OracleRoutineSnapshot> => ({
    endpoint: { connectionId: id, database, schema, databaseType: id === "source" ? "oracle" : "oceanbase-oracle", generation: 1 },
    state: "complete",
    enumerationComplete: true,
    objects: [{ version: { identity: { owner: schema, name: "P", kind: "PACKAGE_BODY" }, objectId: `${id}-body`, status: "VALID", lastDdlTime: "1" }, source: generated.replace('"T"', `"${schema}"`), sourceComplete: true, dependencies: [], dependenciesComplete: true, issues: [] }],
    issues: [],
  }));
  calls.compare.mockResolvedValue({
    diffs: [],
    functionDiffs: [{ type: "modified", name: "P", programKind: "PACKAGE_BODY", source: { name: "P", arguments: "", function_type: "PACKAGE_BODY", definition: generated }, target: { name: "P", arguments: "", function_type: "PACKAGE_BODY", definition: "old target body" } }],
    syncSql: "",
  });
});
afterEach(async () => {
  apps.splice(0).forEach((app) => app.unmount());
  const tracker = useExportTracker();
  tracker.clearFinished();
  await nextTick();
  document.body.innerHTML = "";
});

function button(label: string, enabled = true) {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === label && (!enabled || !button.disabled)).at(-1);
  expect(found, label).toBeDefined();
  return found!;
}
async function openPreview(expectEditor: boolean | "table" = true) {
  const visible = reactive({ open: true, prefillTarget: undefined as string | undefined });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(TooltipProvider, {}, () =>
        h(DataTransferDialog, {
          open: visible.open,
          prefillTargetConnectionId: visible.prefillTarget,
          "onUpdate:open": (value: boolean) => {
            visible.open = value;
          },
        }),
      ),
  });
  apps.push(app);
  app.use(i18n);
  app.mount(host);
  await nextTick();
  button("Load saved package").click();
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(document.querySelector(expectEditor === "table" ? '[data-testid="transfer-table-sql"]' : expectEditor ? '[data-testid="package-editor"]' : '[data-testid="danger-code-preview"]')).not.toBeNull());
  return visible;
}
async function editTargetDraft() {
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!;
  editor.value = corrected;
  editor.dispatchEvent(new Event("input"));
  await nextTick();
}

it.each(["PACKAGE", "PACKAGE_BODY"] as const)("does not restore a deselected same-name %s from retained package drafts", async (removed) => {
  savedTask.config.objects = { PACKAGE: ["P"], PACKAGE_BODY: ["P"] };
  const basePreview = calls.preview.getMockImplementation()!;
  calls.preview.mockImplementation(async (request: TransferRequest) => {
    const result = await basePreview(request);
    const identities = request.objects.flatMap((selection) => (selection.objectType === "PACKAGE" || selection.objectType === "PACKAGE_BODY" ? selection.names.map((name) => ({ owner: "T", name, kind: selection.objectType })) : []));
    result.oraclePackages.input.drafts = identities.map((identity) => ({ identity, sourceName: identity.name, action: "create", sql: `CREATE ${identity.kind === "PACKAGE" ? "PACKAGE" : "PACKAGE BODY"} "T"."P" AS END;` }));
    result.oraclePackages.plan.steps = result.oraclePackages.input.drafts.map((draft) => ({ ...result.oraclePackages.plan.steps[0], identity: draft.identity, sql: draft.sql, operation: null }));
    return result;
  });
  await openPreview();
  button(i18n.global.t("common.cancel")).click();
  await nextTick();
  const toggle = document.querySelector<HTMLButtonElement>(`[data-test="group-${removed}"] [data-test="group-toggle"]`)!;
  expect(toggle).not.toBeNull();
  toggle.click();
  await nextTick();
  button(i18n.global.t("transfer.saveConfig")).click();
  await vi.waitFor(() => expect(calls.save).toHaveBeenCalledOnce());
  const config = calls.save.mock.calls[0][0].config;
  expect(config.objects[removed]).toBeUndefined();
  expect(config.oraclePackageDrafts.map((draft: any) => draft.identity.kind)).toEqual([removed === "PACKAGE" ? "PACKAGE_BODY" : "PACKAGE"]);
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(calls.preview.mock.calls.length).toBeGreaterThan(1));
  expect(calls.preview.mock.calls.at(-1)![0].objects).toEqual([{ objectType: removed === "PACKAGE" ? "PACKAGE_BODY" : "PACKAGE", names: ["P"] }]);
  expect(calls.start).not.toHaveBeenCalled();
});

it("keeps an explicitly added companion in the source selection without cancelling the open preview", async () => {
  const basePreview = calls.preview.getMockImplementation()!;
  calls.preview.mockImplementation(async (request: TransferRequest) => {
    const result = await basePreview(request);
    result.oraclePackages.input.source.objects.push({
      version: { identity: { owner: "S", name: "P", kind: "PACKAGE" }, objectId: "source-spec", status: "VALID", lastDdlTime: "1" },
      source: 'CREATE PACKAGE "S"."P" AS END;',
      sourceComplete: true,
      dependencies: [],
      dependenciesComplete: true,
      issues: [],
    });
    return result;
  });
  await openPreview();
  button(i18n.global.t("diff.packageAddSpecification")).click();
  await nextTick();
  expect(document.querySelector('[data-testid="package-editor"]')).not.toBeNull();
  expect(document.querySelector('[data-test="group-PACKAGE"] [data-test="group-toggle"]')?.getAttribute("data-state")).toBe("all");
  expect(calls.start).not.toHaveBeenCalled();
  button(i18n.global.t("common.cancel")).click();
  await nextTick();
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.saveConfig"), false).disabled).toBe(false));
  button(i18n.global.t("transfer.saveConfig")).click();
  await vi.waitFor(() => expect(calls.save).toHaveBeenCalledOnce());
  expect(calls.save.mock.calls[0][0].config.objects).toEqual({ PACKAGE_BODY: ["P"], PACKAGE: ["P"] });
  expect(calls.save.mock.calls[0][0].config.oraclePackageDrafts.map((draft: any) => draft.identity.kind)).toEqual(["PACKAGE_BODY", "PACKAGE"]);
});

it("replaces an unused Prepared preview with a reviewed mixed-table plan and adopts only its post-table IDs", async () => {
  savedTask.config.objects.TABLE = ["SOURCE"];
  calls.tables.mockImplementation(async (id: string) => (id === "source" ? [{ name: "SOURCE", schema: "S", table_type: "TABLE" }] : []));
  calls.refs.mockImplementation(async (_retain: string[], release: string[]) => {
    release.forEach((id) => records.delete(id));
  });
  const basePreview = calls.preview.getMockImplementation()!;
  const mixedSql = `${corrected}\n-- mixed table dependency`;
  let latest: OraclePackageTransferPreview | undefined;
  calls.preview.mockImplementation(async (request: TransferRequest) => {
    const result = await basePreview(request);
    const mixed = request.oraclePackages?.input?.drafts[0].sql === mixedSql;
    const ddl = `CREATE TABLE "T"."SOURCE"(V VARCHAR2(20${mixed ? " CHAR" : ""}))`;
    result.structure.tables = [{ sourceTable: "SOURCE", targetTable: "SOURCE", preexisting: false, sql: ddl }];
    result.structure.sql = `${ddl};\n${result.structure.sql}`;
    if (mixed) {
      expect(request.oraclePackages!.input!.drafts[0].supersedesOperationId).toMatch(/^original-body-/);
      result.oraclePackages.input = JSON.parse(JSON.stringify(request.oraclePackages!.input!));
      result.oraclePackages.input.drafts[0].supersedesOperationId = undefined;
      result.oraclePackages.plan.ready = false;
      result.oraclePackages.plan.steps[0] = { ...result.oraclePackages.plan.steps[0], sql: mixedSql, issues: [], operation: null };
      result.oraclePackages.pendingTables = {
        source: result.oraclePackages.input.source.endpoint,
        target: result.oraclePackages.input.target.endpoint,
        tables: [{ sourceTable: "SOURCE", finalDdl: ddl }],
        dependencyManifest: { order: [0], steps: [] },
        tableEvidence: [{ sourceTable: "SOURCE", targetTable: "SOURCE", sql: ddl }],
      };
      latest = result.oraclePackages;
    }
    return result;
  });
  calls.start.mockImplementation(async (request: TransferRequest, publish: (event: TransferProgress) => void, started?: () => void) => {
    started?.();
    const input = request.oraclePackages!.input!;
    const operation: OracleRoutineOperation = { operationId: `after-table-${request.transferId}`, target: input.target.endpoint, identity: input.drafts[0].identity, lifecycle: "prepared", dispatched: false, acknowledged: false, error: null, readback: null };
    records.set(operation.operationId, operation);
    const base: TransferProgress = { transferId: request.transferId, table: "SOURCE", tableIndex: 1, totalTables: 1, rowsTransferred: 7, totalRows: 7, status: "tableDone", terminal: false, error: null };
    publish(base);
    publish({ ...base, table: "package objects", rowsTransferred: 0, status: "running", oraclePackageApproval: { input, skipped: [], plan: { ...latest!.plan, ready: true, steps: latest!.plan.steps.map((step) => ({ ...step, operation })) } } });
    const terminal: OracleRoutineOperation = { ...operation, lifecycle: "terminal", dispatched: true, acknowledged: true, readback: { identity: operation.identity, state: "verified", exists: true, version: null, source: mixedSql, definitionMatches: true, compilerMessages: [], issues: [] } };
    records.set(operation.operationId, terminal);
    publish({ ...base, table: "PackageBody:P", rowsTransferred: 0, oracleRoutineOperation: terminal });
    publish({ ...base, table: "", status: "done", terminal: true });
  });
  await openPreview("table");
  button(i18n.global.t("diff.routineSelection")).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[data-testid="package-editor"]')).not.toBeNull());
  await editTargetDraft();
  button(i18n.global.t("diff.routineValidate")).click();
  await vi.waitFor(() => expect(records.size).toBe(1));
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  const oldId = [...records.keys()][0];
  const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!;
  editor.value = mixedSql;
  editor.dispatchEvent(new Event("input"));
  await nextTick();
  button(i18n.global.t("diff.routineValidate")).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="transfer-table-sql"]')?.textContent).toContain("VARCHAR2(20 CHAR)"));
  await vi.waitFor(() => expect(calls.refs.mock.calls.some((call) => call[1]?.includes(oldId))).toBe(true));
  expect(records.size).toBe(0);
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(calls.start).toHaveBeenCalledOnce());
  const request = calls.start.mock.calls[0][0] as TransferRequest;
  expect(request.tables).toEqual(["SOURCE"]);
  expect(request.oraclePackages?.operationIds).toEqual([]);
  expect(request.oraclePackages?.pendingTables).toEqual(latest!.pendingTables);
  const task = useExportTracker().tasks.value.find((task) => task.exportId === request.transferId)!;
  await vi.waitFor(() => expect(task.oracleRoutineDeployment?.drafts[0].operation?.lifecycle).toBe("terminal"));
  expect(task.oracleRoutineDeployment?.records.map((record) => record.operationId)).toEqual([`after-table-${request.transferId}`]);
  expect(task.rowsExported).toBe(7);
  expect(task.status).toBe("Done");
});

it("loads the saved BODY-only task, edits and validates in the real preview, then hands off exact SQL and original approval ID", async () => {
  const visible = await openPreview();
  expect(calls.start).not.toHaveBeenCalled();
  expect(calls.preview.mock.calls[0][0].objects).toEqual([{ objectType: "PACKAGE_BODY", names: ["P"] }]);
  await editTargetDraft();
  expect(calls.start).not.toHaveBeenCalled();
  button(i18n.global.t("diff.routineValidate")).click();
  await vi.waitFor(() => expect(records.size).toBe(1));
  await nextTick();
  expect(calls.preview.mock.calls.at(-1)![0].oraclePackages.input.drafts[0].sql).toBe(corrected);
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(calls.start).toHaveBeenCalledOnce());
  const request = calls.start.mock.calls[0][0];
  const originalId = [...records.keys()][0];
  expect(request.oraclePackages.operationIds).toEqual([originalId]);
  expect(request.oraclePackages.input.drafts[0].sql).toBe(corrected);
  expect(request.objects).toEqual([{ objectType: "PACKAGE_BODY", names: ["P"] }]);
  expect(request.targetConnectionId).toBe("target");
  expect(visible.open).toBe(false);
  expect(useExportTracker().tasks.value[0].oracleRoutineDeployment?.retainedOperationIds).toContain(originalId);
  expect(calls.refs.mock.calls.some((call) => call[1]?.includes(originalId))).toBe(false);
});

it("cancels without dispatch and reopens with the manual draft but fresh source reads and approvals", async () => {
  await openPreview();
  await editTargetDraft();
  button(i18n.global.t("dangerDialog.cancel")).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="package-editor"]')).toBeNull());
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(records.size).toBe(1));
  expect(calls.preview.mock.calls[1][0].oraclePackages).toBeUndefined();
  expect(calls.preview.mock.calls.at(-1)![0].oraclePackages.input.drafts[0].sql).toBe(corrected);
  expect(document.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!.value).toBe(corrected);
  expect(calls.start).not.toHaveBeenCalled();
  button(i18n.global.t("dangerDialog.cancel")).click();
});

it("keeps the original package target and manual draft when the whole transfer dialog closes and reopens", async () => {
  const visible = await openPreview();
  await editTargetDraft();
  visible.open = false;
  await nextTick();
  visible.open = true;
  await nextTick();
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.start")).disabled).toBe(false));
  button(i18n.global.t("transfer.start")).click();
  await vi.waitFor(() => expect(records.size).toBe(1));
  const request = calls.preview.mock.calls.at(-1)![0];
  expect(request.targetConnectionId).toBe("target");
  expect(request.targetSchema).toBe("T");
  expect(request.oraclePackages.input.drafts[0].sql).toBe(corrected);
  expect(calls.start).not.toHaveBeenCalled();
  button(i18n.global.t("dangerDialog.cancel")).click();
});

it("uses the existing unsaved-change decision before a new prefill can replace a retained package target", async () => {
  const visible = await openPreview();
  await editTargetDraft();
  visible.open = false;
  await nextTick();
  visible.prefillTarget = "replacement";
  visible.open = true;
  await nextTick();
  await vi.waitFor(() => expect(button(i18n.global.t("transfer.unsavedDiscard"))).toBeDefined());
  button(i18n.global.t("transfer.cancel")).click();
  await nextTick();
  const target = () => document.querySelectorAll<HTMLSelectElement>('[data-testid="transfer-connection"]')[1];
  expect(target().value).toBe("target");
  visible.open = false;
  await nextTick();
  visible.open = true;
  await nextTick();
  button(i18n.global.t("transfer.unsavedDiscard")).click();
  await vi.waitFor(() => expect(target().value).toBe("replacement"));
  expect(button(i18n.global.t("transfer.start"), false).disabled).toBe(true);
  expect(calls.preview).toHaveBeenCalledOnce();
  expect(calls.start).not.toHaveBeenCalled();
});

it("opens the existing comparison for the same package and target, preserving manual SQL but no transfer approvals", async () => {
  const visible = await openPreview();
  await editTargetDraft();
  button(i18n.global.t("diff.routineValidate")).click();
  await vi.waitFor(() => expect(records.size).toBe(1));
  await vi.waitFor(() => expect(button(i18n.global.t("diff.title"))).toBeDefined());
  button(i18n.global.t("diff.title")).click();
  await vi.waitFor(() => expect(calls.openComparison).toHaveBeenCalledOnce());
  const session = getSchemaDiffSession(calls.openComparison.mock.calls[0][0])!;
  expect(session.status).toBe("completed");
  expect(session.config.options.selectedRoutineObjects).toEqual([{ name: "P", kind: "PACKAGE_BODY" }]);
  expect(session.routineDeployment?.target.endpoint.connectionId).toBe("target");
  expect(session.routineDeployment?.drafts[0]).toMatchObject({ sql: corrected, action: "replace", confirmPackagePair: false });
  expect(session.routineDeployment?.retainedOperationIds).toEqual([]);
  expect(session.routineDeployment?.plan).toBeNull();
  expect(visible.open).toBe(false);
  expect(calls.start).not.toHaveBeenCalled();
});

it("keeps a reviewed manual target draft actionable even when the fresh original sources compare equal", async () => {
  calls.compare.mockResolvedValue({
    diffs: [],
    functionDiffs: [{ type: "equal", name: "P", programKind: "PACKAGE_BODY", source: { name: "P", arguments: "", function_type: "PACKAGE_BODY", definition: generated }, target: { name: "P", arguments: "", function_type: "PACKAGE_BODY", definition: generated } }],
    syncSql: "",
  });
  await openPreview();
  await editTargetDraft();
  button(i18n.global.t("diff.title")).click();
  await vi.waitFor(() => expect(calls.openComparison).toHaveBeenCalledOnce());
  const session = getSchemaDiffSession(calls.openComparison.mock.calls[0][0])!;
  expect(schemaDiffSessionObjects(session.result, session.routineDeployment)[0]).toMatchObject({ operationType: "modify", routineType: "PACKAGE_BODY" });
  expect(session.routineDeployment?.drafts[0]).toMatchObject({ sql: corrected, included: true, action: "replace", reviewedTargetDraft: true });
  expect(calls.start).not.toHaveBeenCalled();
});

it("retains the original preview when a connection generation changes during comparison handoff", async () => {
  const load = calls.load.getMockImplementation()!;
  calls.load.mockImplementation(async (...args) => {
    const snapshot = await load(...args);
    return args[0] === "target" ? { ...snapshot, endpoint: { ...snapshot.endpoint, generation: 2 } } : snapshot;
  });
  const visible = await openPreview();
  await editTargetDraft();
  button(i18n.global.t("diff.title")).click();
  await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledWith(expect.stringContaining("endpoint changed"), 5000));
  expect(visible.open).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!.value).toBe(corrected);
  expect(calls.openComparison).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
});

it("offers comparison when all selected package kinds are skipped without preparing or dispatching a replacement", async () => {
  const preview = calls.preview.getMockImplementation()!;
  calls.preview.mockImplementation(async (request: TransferRequest) => {
    const result = await preview(request);
    result.oraclePackages.input.drafts = [];
    result.oraclePackages.plan.steps = [];
    result.oraclePackages.plan.ready = true;
    result.oraclePackages.skipped = [{ owner: "T", name: "P", kind: "PACKAGE_BODY" }];
    result.structure.sql = "-- Existing PACKAGE BODY T.P is skipped";
    return result;
  });
  await openPreview(false);
  expect(document.body.textContent).toContain("PACKAGE BODY T.P");
  expect(document.body.textContent).toContain(`${i18n.global.t("transfer.structurePlanSkipped")}: PACKAGE BODY T.P`);
  button(i18n.global.t("diff.title")).click();
  await vi.waitFor(() => expect(calls.openComparison).toHaveBeenCalledOnce());
  const session = getSchemaDiffSession(calls.openComparison.mock.calls[0][0])!;
  expect(session.routineDeployment?.drafts[0]).toMatchObject({ action: "replace", identity: { owner: "T", name: "P", kind: "PACKAGE_BODY" } });
  expect(session.routineDeployment?.plan).toBeNull();
  expect(session.routineDeployment?.retainedOperationIds).toEqual([]);
  expect(calls.start).not.toHaveBeenCalled();
});

it("retains the editable transfer draft if its object disappears from the fresh comparison", async () => {
  const load = calls.load.getMockImplementation()!;
  calls.load.mockImplementation(async (...args) => ({ ...(await load(...args)), objects: [] }));
  calls.compare.mockResolvedValue({ diffs: [], functionDiffs: [], syncSql: "" });
  const visible = await openPreview();
  await editTargetDraft();
  button(i18n.global.t("diff.title")).click();
  await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledWith(expect.stringContaining("unavailable in the fresh comparison"), 5000));
  expect(visible.open).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!.value).toBe(corrected);
  expect(calls.openComparison).not.toHaveBeenCalled();
  expect(calls.start).not.toHaveBeenCalled();
});
