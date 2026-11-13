// @vitest-environment happy-dom
import { compile, createApp, defineAsyncComponent, defineComponent, h, nextTick, onMounted, ref, watch, type App, type Ref } from "vue";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import appSource from "../../../App.vue?raw";
import DetachedTabHeader from "../DetachedTabHeader.vue";
import { aiTargetFromTab, type AiConversationBinding } from "@/lib/ai/aiConversationBinding";
import type { AiExternalContextRequest } from "@/lib/ai/aiExternalContext";
import { buildDeduplicatedAppendedEditorSql } from "@/lib/ai/aiSqlAppend";
import { resolveAiSqlTargetTabId } from "@/lib/ai/aiSqlTargetTab";
import { RIGHT_SIDEBAR_PANEL_IDS, transitionRightSidebarPanels } from "@/stores/settingsStore";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useWindowControls", () => ({ useWindowControls: () => ({ isMac: false, isMaximized: false, isAlwaysOnTop: false }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/settingsStore", async (original) => ({
  ...(await original<typeof import("@/stores/settingsStore")>()),
  useSettingsStore: () => ({ editorSettings: { toolbarItems: { alwaysOnTop: false } } }),
}));

// Execute the real shell declarations and template bindings without starting
// unrelated connection, updater and plugin services from the full App.
const script = appSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1];
const source = ts.createSourceFile("App.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string): string {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(source);
    if (ts.isVariableStatement(statement)) {
      const target = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
      if (target) return `${statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${target.getText(source)};`;
    }
  }
  throw new Error(`Missing App declaration: ${name}`);
}
function execute<T>(code: string, deps: Record<string, unknown>): T {
  const compiled = ts.transpileModule(code.replaceAll("import(", "importModule("), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), compiled)(...Object.values(deps));
}
const template = parse(appSource).descriptor.template!.ast!;
type TemplateNode = (typeof template.children)[number];
type ElementNode = Extract<TemplateNode, { type: 1 }>;
function findElement(node: typeof template | TemplateNode, predicate: (element: ElementNode) => boolean): ElementNode | undefined {
  if (node.type === 1 && predicate(node)) return node;
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (typeof child !== "string") {
        const found = findElement(child, predicate);
        if (found) return found;
      }
    }
  }
}
const aiPanel = findElement(template, (node) => node.props.some((prop) => prop.type === 7 && prop.name === "if" && prop.exp?.type === 4 && prop.exp.content.includes("showAiPanel")))!;
const header = findElement(template, (node) => node.tag === "DetachedTabHeader")!.loc.source.replace(/v-else-if="activeTab"/, 'v-if="activeTab"');
const mounted = source.statements.find((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === "onMounted") as ts.ExpressionStatement;
const callback = (mounted.expression as ts.CallExpression).arguments[0] as ts.ArrowFunction;
const detachedStartup = (callback.body as ts.Block).statements.find((statement) => ts.isIfStatement(statement) && statement.expression.getText(source) === "isDetachedWindowContext")!.getText(source);
const names = [
  "showAiPanel",
  "aiPanelReady",
  "aiAssistantRef",
  "isAiPanelMaximized",
  "isHistoryPanelMaximized",
  "showSqlLibraryPanel",
  "showSqlFilePanel",
  "rightSidebarPanelRefs",
  "rightSidebarPanelStorageKeys",
  "lastOpenedRightSidebarPanel",
  "currentRightSidebarPanelState",
  "applyRightSidebarPanelState",
  "setRightSidebarPanelOpen",
  "toggleRightSidebarPanel",
  "openRightSidebarPanel",
  "closeRightSidebarPanel",
  "invokeWhenAiReady",
  "editorAiTarget",
  "sendSelectionToAi",
  "fixWithAi",
  "ensureQueryTabForConnection",
  "aiTargetTabSql",
  "onAiAppendSql",
  "initDetachedWindow",
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mountShell(detached = true) {
  const tab = { id: "detached-query", mode: "query", title: "query.sql", connectionId: "doris", database: "analytics", schema: "public", sql: "SELECT 1;" };
  const ready = ref(false);
  const requests: AiExternalContextRequest[] = [];
  const savePanelPreference = vi.fn();
  const settingsStore = {
    isEditorSettingsLoaded: true,
    editorSettings: { toolbarItems: { exclusiveRightSidebarPanels: false }, aiSqlApplyTargetMode: "new" },
    initEditorSettings: vi.fn(async () => {}),
    initDesktopSettings: vi.fn(async () => {}),
    initAiConfigs: vi.fn(async () => {}),
    reloadAiConfigs: vi.fn(async () => {}),
  };
  const queryStore = {
    tabs: [tab],
    activeTabId: tab.id,
    createTab: vi.fn(() => "hidden-tab"),
    updateSql: vi.fn((id: string, sql: string) => {
      if (id === tab.id) tab.sql = sql;
    }),
    activeResultExecutionTarget: () => tab,
    adoptDetachedTab: vi.fn(async () => {}),
    hydrateSavedSqlTabs: vi.fn(async () => {}),
  };
  let finishLoading!: () => void;
  const apply = (sql: string) => state.onAiAppendSql(sql, { connectionId: tab.connectionId, database: tab.database, schema: tab.schema });
  const Assistant = defineAsyncComponent(
    () =>
      new Promise<ReturnType<typeof defineComponent>>((resolve) => {
        finishLoading = () =>
          resolve(
            defineComponent({
              setup(_, { expose }) {
                expose({ openExternalContext: (request: AiExternalContextRequest) => requests.push(request), prepareForWindowClose: vi.fn(async () => {}) });
                return () => h("div", { "data-test-ai-panel": "" });
              },
            }),
          );
      }),
  );
  const deps = {
    ref,
    watch,
    isDetachedWindowContext: detached,
    detachedContextTabId: tab.id,
    showHistory: ref(false),
    lastFocusedAuxiliarySurface: ref(null),
    lastFocusedSidebarSurface: ref(false),
    isSpecialPageActive: ref(false),
    settingsStore,
    queryStore,
    activeTab: ref(tab),
    connectionStore: { initFromDisk: vi.fn(async () => {}), getConfig: (id: string) => (id === "doris" ? { id } : undefined) },
    aiTargetFromTab,
    resolveAiSqlTargetTabId,
    buildDeduplicatedAppendedEditorSql,
    RIGHT_SIDEBAR_PANEL_IDS,
    transitionRightSidebarPanels,
    safeLocalStorageGet: () => "true",
    safeLocalStorageSet: savePanelPreference,
    routeAiRedisCommand: () => false,
    settleAiSqlAction: vi.fn(),
    queryErrorSelection: () => ({ source: "query-error", content: tab.sql }),
    api: { loadDetachedTabHandoff: vi.fn(async () => ({ revision: 1, runtime: {} })) },
    savedSqlStore: { initFromStorage: vi.fn(async () => {}) },
    initSavedSqlEditorPositions: vi.fn(async () => {}),
    importModule: async () => ({ emit: vi.fn() }),
    toast: vi.fn(),
    refreshDetachedAiConfigs: vi.fn(),
    t: (key: string) => key,
    activeOutputView: ref("result"),
    finishDetachedWindowClose: vi.fn(),
  };
  let state!: {
    showAiPanel: Ref<boolean>;
    aiPanelReady: Ref<boolean>;
    sendSelectionToAi: (tabId: string, sql: string) => void;
    fixWithAi: (tabId: string, error: string) => void;
    closeRightSidebarPanel: (id: string) => void;
    onAiAppendSql: (sql: string, binding: AiConversationBinding) => void;
    ensureQueryTabForConnection: (binding: AiConversationBinding) => string;
  };
  const root = document.createElement("div");
  document.body.append(root);
  const app: App = createApp({
    components: { AiAssistant: Assistant, DetachedTabHeader },
    setup() {
      state = execute(`${names.map(declaration).join("\n")} return { ${names.join(", ")} };`, deps);
      onMounted(async () => {
        await execute<Promise<void>>(`return (async () => { ${detachedStartup} })();`, {
          ...deps,
          ...state,
          initializeUpdatePreparation: async () => {},
          setupDetachedWindowEvents: async () => {},
          updateWindowReady: false,
          window: { addEventListener: vi.fn() },
        });
        ready.value = true;
      });
      return {
        ...state,
        ...deps,
        showAiPanel: state.showAiPanel,
        activeConnection: {},
        isClassicLayout: false,
        isZenMode: false,
        aiPanelWidth: 360,
        activePluginAiRecommendations: undefined,
        toggleAiPanelMaximized: vi.fn(),
        openAiSettings: vi.fn(),
        rememberAuxiliarySearchSurface: vi.fn(),
        startAiPanelResize: vi.fn(),
        onAiExecuteSql: vi.fn(),
        onAiTempRunSql: vi.fn(),
        onAiRequestAutoExecuteSql: vi.fn(),
        onAiOpenExplainPlan: vi.fn(),
        activeTab: tab,
        queryStore: { ...queryStore, isTabDirty: () => false },
        requestDetachedReturn: vi.fn(),
        handleDetachedHeaderDragStart: vi.fn(),
        handleDetachedHeaderDragging: vi.fn(),
        handleDetachedHeaderDragEnd: vi.fn(),
      };
    },
    render: compile(`<div>${header}${aiPanel.loc.source.replaceAll(": string", "").replaceAll(": AiConversationBinding", "")}</div>`),
  });
  app.mount(root);
  cleanups.push(() => {
    app.unmount();
    root.remove();
  });
  return {
    ...state,
    ready,
    root,
    requests,
    settingsStore,
    queryStore,
    tab,
    savePanelPreference,
    apply,
    loadPanel: async () => {
      await vi.waitFor(() => expect(finishLoading).toBeTypeOf("function"));
      finishLoading();
      await vi.waitFor(() => expect(root.querySelector("[data-test-ai-panel]")).not.toBeNull());
    },
  };
}

describe("AI in a detached editor", () => {
  it("loads settings and forwards the first selection after the lazy panel mounts", async () => {
    const shell = mountShell();
    await vi.waitFor(() => expect(shell.ready.value).toBe(true));
    expect(shell.settingsStore.initAiConfigs).toHaveBeenCalledOnce();
    expect(shell.showAiPanel.value).toBe(false);
    shell.sendSelectionToAi(shell.tab.id, "SELECT * FROM orders;");
    await nextTick();
    expect(shell.requests).toHaveLength(0);
    await shell.loadPanel();
    expect(shell.requests).toEqual([expect.objectContaining({ target: { connectionId: "doris", database: "analytics", schema: "public" }, selections: [expect.objectContaining({ content: "SELECT * FROM orders;" })] })]);
  });

  it("opens from the header, supports error repair, and leaves main-window panel preferences alone", async () => {
    const shell = mountShell();
    await vi.waitFor(() => expect(shell.ready.value).toBe(true));
    const button = shell.root.querySelector<HTMLButtonElement>('[aria-label="AI"]')!;
    button.click();
    await shell.loadPanel();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    shell.fixWithAi(shell.tab.id, "Unknown column");
    expect(shell.requests.at(-1)).toMatchObject({ action: "fix", instruction: "Unknown column", target: { connectionId: "doris", database: "analytics", schema: "public" } });
    button.click();
    await nextTick();
    expect(shell.root.querySelector("[data-test-ai-panel]")).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(shell.savePanelPreference).not.toHaveBeenCalled();
  });

  it("applies SQL to the detached editor even when the normal preference creates a new tab", () => {
    const shell = mountShell();
    shell.apply("SELECT 2;");
    expect(shell.queryStore.updateSql).toHaveBeenCalledWith(shell.tab.id, expect.stringContaining("SELECT 2;"));
    expect(shell.queryStore.createTab).not.toHaveBeenCalled();
    expect(shell.ensureQueryTabForConnection({ connectionId: "other", database: "analytics" })).toBe("");
  });

  it("opens AI settings in the main window", async () => {
    const emitTo = vi.fn(async () => {});
    const openSettings = vi.fn();
    const open = execute<() => Promise<void>>(`${declaration("openAiSettings")} return openAiSettings;`, {
      isDetachedWindowContext: true,
      openSettings,
      importModule: async () => ({ emitTo }),
    });
    await open();
    expect(emitTo).toHaveBeenCalledWith("main", "dbx:open-ai-settings");
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("waits for AI cancellation and persistence before closing the native window", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepareForWindowClose = vi.fn(() => pending);
    const approveDetachedWindowClose = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const finishClose = execute<() => Promise<void>>(`${declaration("finishDetachedWindowClose")} return finishDetachedWindowClose;`, {
      isDetachedWindowContext: true,
      detachedCloseInProgress: false,
      aiAssistantRef: ref({ prepareForWindowClose }),
      api: { approveDetachedWindowClose },
      importModule: async () => ({ getCurrentWindow: () => ({ close }) }),
    });
    const closing = finishClose();
    expect(prepareForWindowClose).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(approveDetachedWindowClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
