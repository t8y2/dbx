// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { createOracleRoutineDeployment } from "@/lib/schema/oracleRoutineDeploy";
import type { OracleRoutineOperation } from "@/types/schemaDiff";

const mocks = vi.hoisted(() => ({
  cancelTransfer: vi.fn(),
  prepare: vi.fn(),
  observe: vi.fn(),
  execute: vi.fn(),
  refs: vi.fn(),
  guard: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  cancelDatabaseExport: vi.fn(),
  cancelSqlFileExecution: vi.fn(),
  cancelTableExport: vi.fn(),
  cancelTransfer: mocks.cancelTransfer,
  startTransfer: vi.fn(),
  prepareOracleRoutinePlan: mocks.prepare,
  observeOracleRoutineOperation: mocks.observe,
  executeOracleRoutineOperation: mocks.execute,
  updateOracleRoutineOperationReferences: mocks.refs,
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => undefined }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionSqlGuard: mocks.guard }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 12, fontFamily: "monospace" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (text: string) => text }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ invalidateObjectDdlCache: vi.fn() }));
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

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    props: { open: { type: Boolean, default: undefined } },
    setup(props, { slots }) {
      return () => (props.open === false ? null : h("div", slots.default?.()));
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { slots }) {
        return () => h("button", slots.default?.());
      },
    }),
  };
});

import DataTransferProgressDialog from "@/components/transfer/DataTransferProgressDialog.vue";
import { useExportTracker } from "@/composables/useExportTracker";

const mountedApps: App[] = [];

function resetTracker() {
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refs.mockResolvedValue(undefined);
  mocks.guard.mockImplementation(async (options: { execute: () => Promise<void> }) => options.execute());
  resetTracker();
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  resetTracker();
});

describe("DataTransferProgressDialog", () => {
  it("reopens the original package result, edits an invalid body and deploys only its newly validated correction", async () => {
    const endpoint = { connectionId: "target", database: "tenant", schema: "T", databaseType: "oceanbase-oracle" as const, generation: 1 };
    const target = { endpoint, state: "complete" as const, enumerationComplete: true, objects: [], issues: [] };
    const state = reactive(createOracleRoutineDeployment({ ...target, endpoint: { ...endpoint, connectionId: "source", schema: "S" } }, target));
    const record = (kind: "PACKAGE" | "PACKAGE_BODY", id: string, invalid = false): OracleRoutineOperation => {
      const identity = { owner: "T", name: "P", kind };
      return {
        operationId: id,
        target: endpoint,
        identity,
        lifecycle: "terminal",
        dispatched: true,
        acknowledged: true,
        error: null,
        readback: { identity, state: invalid ? "invalid" : "verified", exists: true, version: null, source: "original full definition", definitionMatches: true, issues: [], compilerMessages: invalid ? [{ attribute: "ERROR", line: 2, position: 3, text: "PLS-00323" }] : [] },
      };
    };
    const specification = record("PACKAGE", "original-spec");
    const body = record("PACKAGE_BODY", "original-body", true);
    state.records = [specification, body];
    state.drafts = [specification, body].map((operation, index) => ({ identity: operation.identity, action: "create", sourceName: "P", sql: index ? 'CREATE PACKAGE BODY "T"."P" AS END;' : 'CREATE PACKAGE "T"."P" AS END;', objectId: `package-${index}`, included: true, operation }));
    state.selectedObjectId = "package-1";
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("original-package-failure", "source → target", 0);
    task.status = "Error";
    task.oracleRoutineDeployment = state;
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({ render: () => h(DataTransferProgressDialog, { open: true, task }) });
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="package-editor"]')).not.toBeNull());
    expect(container.textContent).toContain("PLS-00323");
    expect(container.textContent).not.toContain("0 / 0");
    const corrected = 'CREATE OR REPLACE PACKAGE BODY "T"."P" AS -- corrected 中文😀\nEND;';
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="package-editor"]')!;
    editor.value = corrected;
    editor.dispatchEvent(new Event("input"));
    await nextTick();
    mocks.observe.mockResolvedValue({ operation: body, lifecycle: "terminal", error: null });
    const prepared = { ...body, operationId: "new-body", lifecycle: "prepared" as const, dispatched: false, acknowledged: false, readback: null };
    mocks.prepare.mockResolvedValue({
      target: endpoint,
      ready: true,
      steps: [{ identity: body.identity, action: "replace", sql: corrected, sourceOriginal: "complete source body", targetOriginal: "original full definition", recoverySql: null, recoveryComplete: true, references: [], incomingCallers: [], issues: [], operation: prepared }],
    });
    const click = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)!.click();
    click(i18n.global.t("diff.routineValidate"));
    await vi.waitFor(() => expect(state.plan?.ready).toBe(true));
    expect(mocks.prepare.mock.calls[0][0].drafts).toEqual([expect.objectContaining({ identity: body.identity, action: "replace", sql: corrected, baselineOperationId: "original-body" })]);
    mocks.execute.mockResolvedValue({ ...record("PACKAGE_BODY", "new-body"), readback: { ...record("PACKAGE_BODY", "new-body").readback!, source: corrected } });
    click(i18n.global.t("diff.deployToServer"));
    await nextTick();
    expect(mocks.execute).not.toHaveBeenCalled();
    click(i18n.global.t("dangerDialog.confirm"));
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledWith("new-body", corrected));
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(state.drafts[0].operation?.operationId).toBe("original-spec");
    expect(task.status).toBe("Error");
  });

  it("minimizes without cancelling and keeps the explicit cancel action", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("transfer-progress", "source → target", 2);
    let dialogOpen!: Ref<boolean>;
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup() {
          dialogOpen = ref(true);
          return () => h(DataTransferProgressDialog, { open: dialogOpen.value, "onUpdate:open": (value: boolean) => (dialogOpen.value = value), task });
        },
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    buttons()
      .find((button) => button.textContent?.includes("Minimize to background"))
      ?.click();
    await nextTick();
    expect(dialogOpen.value).toBe(false);
    expect(mocks.cancelTransfer).not.toHaveBeenCalled();
    expect(task.status).toBe("Running");

    dialogOpen.value = true;
    await nextTick();
    buttons()
      .find((button) => button.textContent?.trim() === "Cancel")
      ?.click();
    await vi.waitFor(() => expect(mocks.cancelTransfer).toHaveBeenCalledWith(task.exportId));
  });

  it("records per-table log lines and a terminal summary for data transfer tasks (#13281)", () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("transfer-log-flow", "source → target", 2);
    const progress = (overrides: Partial<Record<"table" | "tableIndex" | "rowsTransferred" | "status" | "terminal" | "error", unknown>>) =>
      tracker.updateDataTransferTask("transfer-log-flow", {
        transferId: "transfer-log-flow",
        table: "",
        tableIndex: 0,
        totalTables: 2,
        rowsTransferred: 0,
        totalRows: null,
        status: "running",
        error: null,
        terminal: false,
        ...overrides,
      } as Parameters<typeof tracker.updateDataTransferTask>[1]);

    progress({ table: "users", tableIndex: 0, rowsTransferred: 10 });
    // 同表的后续行块进度事件不重复记日志。
    progress({ table: "users", tableIndex: 0, rowsTransferred: 120 });
    progress({ table: "orders", tableIndex: 1, rowsTransferred: 5 });
    progress({ table: "orders", tableIndex: 2, rowsTransferred: 99, status: "done", terminal: true });

    const lines = task.logLines!;
    expect(lines.map((line) => line.key)).toEqual(["transfer.log.tableStarted", "transfer.log.tableStarted", "transfer.log.completed"]);
    expect(lines[0].params).toMatchObject({ table: "users", index: 1, total: 2 });
    expect(lines[1].params).toMatchObject({ table: "orders", index: 2, total: 2 });
    expect(lines[2].level).toBe("success");
  });

  it("renders the collapsible execution log with per-line timestamps (#13281)", async () => {
    const tracker = useExportTracker();
    const task = tracker.addDataTransferTask("transfer-log-ui", "source → target", 1);
    task.logLines = [
      { at: new Date(2026, 0, 1, 12, 30, 5).getTime(), key: "transfer.log.tableStarted", params: { table: "users", index: 1, total: 1 }, level: "info" },
      { at: new Date(2026, 0, 1, 12, 30, 6).getTime(), key: "transfer.log.completed", params: { total: 1, failed: 0 }, level: "success" },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({ render: () => h(DataTransferProgressDialog, { open: true, task }) });
    mountedApps.push(app);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const logText = i18n.global.t("transfer.log.title");
    const toggle = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(logText));
    expect(toggle).toBeDefined();
    expect(container.textContent).toContain("12:30:05");
    expect(container.textContent).toContain("Transferring table users (1/1)");
    expect(container.textContent).toContain("Transfer finished: 1 table(s), 0 failed");

    // 折叠走 v-show（display:none），textContent 仍包含文本，改查容器样式。
    const logBody = () => [...document.body.querySelectorAll<HTMLDivElement>("div")].find((div) => div.className.includes("font-mono"));
    expect(logBody()).toBeDefined();
    toggle!.click();
    await nextTick();
    expect(logBody()!.style.display).toBe("none");
    expect([...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(logText))).toBeDefined();
  });
});
