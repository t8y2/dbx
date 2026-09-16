// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: {
    name: "ButtonStub",
    template: `<button><slot /></button>`,
  },
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: {
    name: "SearchableSelectStub",
    template: `<div />`,
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: {
    name: "TooltipStub",
    template: `<span><slot /></span>`,
  },
  TooltipTrigger: {
    name: "TooltipTriggerStub",
    template: `<span><slot /></span>`,
  },
  TooltipContent: {
    name: "TooltipContentStub",
    template: `<span><slot /></span>`,
  },
}));

vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({
  default: {
    name: "TruncatedTextTooltipStub",
    template: `<span />`,
  },
}));

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({
  default: {
    name: "DatabaseIconStub",
    template: `<span />`,
  },
}));

vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({
  default: {
    name: "ConnectionTreeSelectStub",
    template: `<div />`,
  },
}));

vi.mock("@/components/common/ProductionContextBadge.vue", () => ({
  default: {
    name: "ProductionContextBadgeStub",
    template: `<span />`,
  },
}));

import EditorToolbar from "../EditorToolbar.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { resolveExecutableSql, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import { EditorView } from "@codemirror/view";

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("EditorToolbar mount contract", () => {
  let pinia: ReturnType<typeof createPinia>;
  let i18n: ReturnType<typeof createI18n>;

  beforeEach(() => {
    document.body.innerHTML = "";
    pinia = createPinia();
    setActivePinia(pinia);
    i18n = createI18n({
      legacy: false,
      locale: "en",
      messages: { en: {} },
    });
  });

  it("emits toolbarExecute instead of execute when the run button is clicked", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-1",
        name: "conn",
        db_type: "mysql",
        color: "",
      } as never,
    ];

    const host = createHost();
    const onToolbarExecute = vi.fn();
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-1",
        title: "SQL",
        connectionId: "conn-1",
        database: "db",
        sql: "SELECT 1",
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-1"),
      executableSql: "SELECT 1",
      explainMode: "explain",
      blockDangerousRedisCommands: false,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
      onToolbarExecute,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    const runButton = buttons[0];
    runButton.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await nextTick();

    expect(onToolbarExecute).toHaveBeenCalledTimes(1);
    expect(onToolbarExecute.mock.calls[0]?.[0]).toBe("pointer");

    app.unmount();
    host.remove();
  });

  it("keeps the manually selected SQL from pointer-down through toolbar execution", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-1",
        name: "conn",
        db_type: "postgres",
        color: "",
      } as never,
    ];

    const fullSql = "SELECT first_value;\nSELECT selected_value;";
    const selectedSql = "SELECT selected_value;";
    const snapshot = {
      fullSql,
      selectedSql,
      cursorPos: fullSql.length,
      selectionFrom: fullSql.indexOf(selectedSql),
      selectionTo: fullSql.length,
    };
    let pendingSnapshot: typeof snapshot | undefined;
    let executedSql = "";
    const onExecutePointerDown = vi.fn(() => {
      pendingSnapshot = snapshot;
    });
    const onToolbarExecute = vi.fn((source: "pointer" | "keyboard") => {
      executedSql = source === "pointer" && pendingSnapshot ? resolveExecutableSql(pendingSnapshot.fullSql, pendingSnapshot.selectedSql, { mode: "current", cursorPos: pendingSnapshot.cursorPos }) : fullSql;
    });

    const host = createHost();
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-1",
        title: "SQL",
        connectionId: "conn-1",
        database: "db",
        sql: fullSql,
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-1"),
      executableSql: selectedSql,
      explainMode: "explain",
      blockDangerousRedisCommands: false,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
      onExecutePointerDown,
      onToolbarExecute,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    const runButton = host.querySelectorAll("button")[0];
    runButton?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    runButton?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await nextTick();

    expect(onExecutePointerDown).toHaveBeenCalledTimes(1);
    expect(onToolbarExecute).toHaveBeenCalledWith("pointer");
    expect(onExecutePointerDown.mock.invocationCallOrder[0]).toBeLessThan(onToolbarExecute.mock.invocationCallOrder[0]!);
    expect(executedSql).toBe(selectedSql);

    app.unmount();
    host.remove();
  });

  it("executes the exact CodeMirror selection after the toolbar click moves focus", async () => {
    const connectionStore = useConnectionStore();
    const connection = {
      id: "conn-1",
      name: "conn",
      db_type: "postgres",
      color: "",
    } as never;
    connectionStore.connections = [connection];

    const fullSql = "SELECT first_value;\nSELECT selected_value;";
    const selectedSql = "SELECT selected_value;";
    const selectionFrom = fullSql.indexOf(selectedSql);
    const editorRef = ref<{ captureExecutionSnapshot?: () => SqlExecutionSnapshot | undefined } | null>(null);
    const state = reactive({ sql: fullSql });
    let pendingSnapshot: SqlExecutionSnapshot | undefined;
    let executedSql = "";

    const host = createHost();
    const app = createApp({
      setup() {
        return () =>
          h("div", [
            h(QueryEditor, {
              ref: editorRef,
              modelValue: state.sql,
              tabId: "tab-1",
              connectionId: "conn-1",
              database: "db",
              databaseType: "postgres",
              dialect: "postgres",
              autoFocus: false,
              "onUpdate:modelValue": (value: string) => (state.sql = value),
            }),
            h(EditorToolbar, {
              activeTab: {
                id: "tab-1",
                title: "SQL",
                connectionId: "conn-1",
                database: "db",
                sql: fullSql,
                mode: "query",
                isExecuting: false,
                isCancelling: false,
                isExplaining: false,
              },
              activeConnection: connection,
              executableSql: fullSql,
              explainMode: "explain",
              blockDangerousRedisCommands: false,
              sqlKeywordCase: "preserve",
              databaseRequiredSignal: 0,
              autoCommit: true,
              txnSessionId: undefined,
              txnAutoRolledBack: false,
              oracleTxnPossiblyDirty: false,
              isOracleManualTransaction: false,
              onExecutePointerDown: () => {
                pendingSnapshot = editorRef.value?.captureExecutionSnapshot?.();
              },
              onToolbarExecute: (source: "pointer" | "keyboard") => {
                executedSql = source === "pointer" && pendingSnapshot ? resolveExecutableSql(pendingSnapshot.fullSql, pendingSnapshot.selectedSql, { mode: "current", cursorPos: pendingSnapshot.cursorPos }) : fullSql;
              },
            }),
          ]);
      },
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });

    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: selectionFrom, head: fullSql.length } });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(selectedSql);

    const runButton = host.querySelector<HTMLElement>(".app-editor-toolbar button");
    runButton?.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    runButton?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await nextTick();

    expect(pendingSnapshot?.selectedSql).toBe(selectedSql);
    expect(executedSql).toBe(selectedSql);

    app.unmount();
    host.remove();
  });

  it("does not expose SQL formatting for Redis connections", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-redis",
        name: "redis",
        db_type: "redis",
        host: "localhost",
        port: 6379,
      } as never,
    ];

    const host = createHost();
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-redis",
        title: "Redis",
        connectionId: "conn-redis",
        database: "0",
        sql: 'SET user:1 "hello world"',
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-redis"),
      executableSql: 'SET user:1 "hello world"',
      explainMode: "explain",
      blockDangerousRedisCommands: true,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();

    expect(host.textContent).not.toContain("toolbar.formatSql");

    app.unmount();
    host.remove();
  });

  it("mounts for a schema-aware connection whose watchEffect reads tier-gated selectors", async () => {
    // Regression: the tier-gated showSchemaSelector is read eagerly by the
    // schema-loading watchEffect, so the tier refs must be declared before any
    // computed that references them (a Postgres connection takes this branch;
    // MySQL never did, which is why the TDZ crash only reproduced live).
    const connectionStore = useConnectionStore();
    connectionStore.connections = [
      {
        id: "conn-pg",
        name: "pg",
        db_type: "postgres",
        host: "localhost",
        port: 5432,
        username: "root",
        password: "",
      } as never,
    ];

    const host = createHost();
    const errors: unknown[] = [];
    const app = createApp(EditorToolbar, {
      activeTab: {
        id: "tab-pg",
        title: "SQL",
        connectionId: "conn-pg",
        database: "app",
        sql: "SELECT 1",
        mode: "query",
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      },
      activeConnection: connectionStore.getConfig("conn-pg"),
      executableSql: "SELECT 1",
      explainMode: "explain",
      blockDangerousRedisCommands: false,
      sqlKeywordCase: "preserve",
      databaseRequiredSignal: 0,
      autoCommit: true,
      txnSessionId: undefined,
      txnAutoRolledBack: false,
      oracleTxnPossiblyDirty: false,
      isOracleManualTransaction: false,
    });
    app.config.errorHandler = (err) => {
      errors.push(err);
    };
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    await nextTick();

    expect(errors).toEqual([]);
    expect(host.querySelector(".app-editor-toolbar")).not.toBeNull();

    app.unmount();
    host.remove();
  });
});
