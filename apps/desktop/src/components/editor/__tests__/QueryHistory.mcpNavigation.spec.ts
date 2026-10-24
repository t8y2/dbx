// @vitest-environment happy-dom
import ts from "typescript";
import { compile, createApp, defineAsyncComponent, nextTick, ref, watch, type App, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueryHistory from "../QueryHistory.vue";
import appSource from "../../../App.vue?raw";
import type { McpCallHistoryRequest, McpCallHistoryResource } from "@/lib/mcp/mcpCallHistory";
import { RIGHT_SIDEBAR_PANEL_IDS, transitionRightSidebarPanels } from "@/stores/settingsStore";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  loadConnectionOptions: vi.fn(),
  getConfig: vi.fn(),
  connectionOptions: [] as Array<{ connection_id: string; connection_name: string; databases: string[] }>,
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({
    entries: [],
    get connectionOptions() {
      return mocks.connectionOptions;
    },
    total: 0,
    loading: false,
    error: "",
    nextCursor: null,
    setHistoryPanelActive: vi.fn(),
    loadConnectionOptions: mocks.loadConnectionOptions,
    search: mocks.search,
  }),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: mocks.getConfig }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (text: string) => text }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionSqlGuard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({}));

// Exercise the real shell handler, component bindings and lazy history panel.
// Delay the loader past nextTick to reproduce the first-open race from the UI.
const script = appSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("App script setup was not found");
const source = ts.createSourceFile("App.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = [
  "showHistory",
  "mcpHistoryRequest",
  "openMcpCallHistory",
  "showAiPanel",
  "isAiPanelMaximized",
  "isHistoryPanelMaximized",
  "showSqlLibraryPanel",
  "showSqlFilePanel",
  "rightSidebarPanelRefs",
  "rightSidebarPanelStorageKeys",
  "lastOpenedRightSidebarPanel",
  "lastFocusedAuxiliarySurface",
  "lastFocusedSidebarSurface",
  "currentRightSidebarPanelState",
  "applyRightSidebarPanelState",
  "setRightSidebarPanelOpen",
  "openRightSidebarPanel",
  "closeRightSidebarPanel",
];
const declarations = names.map((name) => {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(source);
    if (ts.isVariableStatement(statement)) {
      const target = statement.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
      if (target) return `${statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${target.getText(source)};`;
    }
  }
  throw new Error(`Missing App declaration: ${name}`);
});
const historyLifecycleWatches = source.statements.filter((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === "watch" && statement.expression.arguments[0]?.getText(source) === "showHistory");
const compiled = ts.transpileModule([...declarations, ...historyLifecycleWatches.map((statement) => statement.getText(source))].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const historyTemplate = appSource.match(/<QueryHistory\s[\s\S]*?\/>/)?.[0];
if (!historyTemplate) throw new Error("App history panel was not found");

let app: App | undefined;
function mountShell() {
  const isSpecialPageActive = ref(false);
  const settingsStore = { isEditorSettingsLoaded: true, editorSettings: { toolbarItems: { exclusiveRightSidebarPanels: false } } };
  const deps = {
    ref,
    watch,
    RIGHT_SIDEBAR_PANEL_IDS,
    transitionRightSidebarPanels,
    settingsStore,
    isSpecialPageActive,
    activateQuerySurface: () => {
      isSpecialPageActive.value = false;
    },
    safeLocalStorageGet: () => null,
    safeLocalStorageSet: vi.fn(),
  };
  let state!: {
    showHistory: Ref<boolean>;
    showAiPanel: Ref<boolean>;
    isAiPanelMaximized: Ref<boolean>;
    isHistoryPanelMaximized: Ref<boolean>;
    mcpHistoryRequest: Ref<McpCallHistoryRequest | null>;
    openMcpCallHistory: (event: Event) => void;
    openRightSidebarPanel: (id: string) => void;
    closeRightSidebarPanel: (id: string) => void;
  };
  let resolve!: (component: typeof QueryHistory) => void;
  const LazyHistory = defineAsyncComponent(
    () =>
      new Promise<typeof QueryHistory>((done) => {
        resolve = done;
      }),
  );
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp({
    components: { QueryHistory: LazyHistory },
    setup: () => {
      state = new Function(...Object.keys(deps), `${compiled}; return { ${names.join(", ")} };`)(...Object.values(deps));
      return { ...state, activeTab: undefined, restoreHistorySql: vi.fn(), analyzeHistoryWithAi: vi.fn() };
    },
    render: compile(`<div v-if="showHistory">${historyTemplate}</div>`),
  });
  app.mount(root);
  return {
    ...state,
    isSpecialPageActive,
    settingsStore,
    root,
    open: (resource?: McpCallHistoryResource) => state.openMcpCallHistory(new CustomEvent("open", { detail: resource })),
    resolve: async (expectedSource = "mcp") => {
      resolve(QueryHistory);
      await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ source: expectedSource })));
    },
  };
}

beforeEach(() => {
  mocks.connectionOptions = [];
  mocks.getConfig.mockReset().mockReturnValue({ name: "Test" });
  mocks.search.mockReset().mockResolvedValue(undefined);
  mocks.loadConnectionOptions.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  app?.unmount();
  document.body.textContent = "";
});

describe("MCP history navigation", () => {
  function clickButton(root: HTMLElement, text: string) {
    const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
    expect(button, `Missing button: ${text}`).toBeDefined();
    button!.click();
  }

  it("opens MCP on the first lazy mount, even after the shell's next tick", async () => {
    const shell = mountShell();
    shell.open();
    await nextTick();
    await nextTick();
    expect(mocks.search).not.toHaveBeenCalled();
    await shell.resolve();
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp" }));
    expect(shell.mcpHistoryRequest.value).toBeNull();
  });

  it("handles a new request while mounted and does not replay it on an ordinary reopen", async () => {
    const shell = mountShell();
    shell.open();
    await nextTick();
    await shell.resolve();
    const sqlButton = [...shell.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "history.sources.sql")!;
    expect(sqlButton).toBeDefined();
    sqlButton.click();
    await nextTick();
    expect(shell.root.querySelector("[data-mcp-tool-search]")).toBeNull();
    shell.open();
    await nextTick();
    expect(shell.root.querySelector("[data-mcp-tool-search]")).not.toBeNull();
    expect(shell.mcpHistoryRequest.value).toBeNull();
    shell.showHistory.value = false;
    await nextTick();
    mocks.search.mockClear();
    shell.showHistory.value = true;
    await nextTick();
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ source: "sql" }));
  });

  it("applies the requested scope on first mount without waiting for connection options", async () => {
    let resolveOptions!: () => void;
    mocks.loadConnectionOptions.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "analytics" });
    await nextTick();
    await shell.resolve();
    expect(mocks.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "mcp",
        connections: [{ connection_id: "c1", connection_name: "Test" }],
        databases: [{ connection_id: "c1", connection_name: "Test", database: "analytics" }],
      }),
    );
    mocks.connectionOptions = [{ connection_id: "c1", connection_name: "Test", databases: ["analytics"] }];
    resolveOptions();
    await vi.waitFor(() =>
      expect(mocks.search).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "mcp",
          connections: [{ connection_id: "c1", connection_name: "Test" }],
          databases: [{ connection_id: "c1", connection_name: "Test", database: "analytics" }],
        }),
      ),
    );
  });

  it.each([false, true])("cancels an unconsumed request before its first load (same tick reopen: %s)", async (sameTick) => {
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "analytics" });
    await nextTick();
    shell.closeRightSidebarPanel("history");
    if (!sameTick) await nextTick();
    shell.openRightSidebarPanel("history");
    await shell.resolve("sql");
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "sql", connections: [], databases: [] }));
  });

  it.each([false, true])("reveals history from settings and maximized AI (exclusive panels: %s)", async (exclusive) => {
    const shell = mountShell();
    shell.isSpecialPageActive.value = true;
    shell.showAiPanel.value = true;
    shell.isAiPanelMaximized.value = true;
    shell.settingsStore.editorSettings.toolbarItems.exclusiveRightSidebarPanels = exclusive;
    shell.open();
    await nextTick();
    await shell.resolve();
    expect(shell.isSpecialPageActive.value).toBe(false);
    expect(shell.isAiPanelMaximized.value).toBe(false);
    expect(shell.showAiPanel.value).toBe(!exclusive);
  });

  it("does not carry an invisible SQL activity filter into MCP navigation", async () => {
    const shell = mountShell();
    shell.open();
    await nextTick();
    await shell.resolve();
    clickButton(shell.root, "history.sources.sql");
    await nextTick();
    clickButton(shell.root, "history.filters.schema_change");
    await nextTick();
    mocks.search.mockClear();
    shell.open();
    await vi.waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "mcp", activity_kind: undefined })));
  });

  it("does not undo a user's source selection when connection options arrive late", async () => {
    let resolveOptions!: () => void;
    mocks.loadConnectionOptions.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "analytics" });
    await nextTick();
    await shell.resolve();
    clickButton(shell.root, "history.sources.sql");
    await nextTick();
    mocks.connectionOptions = [{ connection_id: "c1", connection_name: "Test", databases: ["analytics"] }];
    resolveOptions();
    await nextTick();
    await nextTick();
    expect(shell.root.querySelector("[data-mcp-tool-search]")).toBeNull();
  });

  it.each(["empty", "failed", "missing database"])("keeps exact resource filters when the connection options are %s", async (result) => {
    if (result === "failed") mocks.loadConnectionOptions.mockRejectedValue(new Error("options unavailable"));
    if (result === "missing database") mocks.connectionOptions = [{ connection_id: "c1", connection_name: "Test", databases: ["old_database"] }];
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "new_database" });
    await nextTick();
    await shell.resolve();
    expect(mocks.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connections: [{ connection_id: "c1", connection_name: "Test" }],
        databases: [{ connection_id: "c1", connection_name: "Test", database: "new_database" }],
      }),
    );
  });

  it.each([false, true])("uses only the latest request while the panel is loading (global: %s)", async (global) => {
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "old_database" });
    await nextTick();
    shell.open(global ? undefined : { connectionId: "c2", database: "latest_database" });
    await nextTick();
    await shell.resolve();
    expect(mocks.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "mcp",
        connections: global ? [] : [{ connection_id: "c2", connection_name: "Test" }],
        databases: global ? [] : [{ connection_id: "c2", connection_name: "Test", database: "latest_database" }],
      }),
    );
  });

  it("clears a previous resource scope when the global MCP entry is opened", async () => {
    const shell = mountShell();
    shell.open({ connectionId: "c1", database: "analytics" });
    await nextTick();
    await shell.resolve();
    mocks.search.mockClear();
    shell.open();
    await vi.waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ source: "mcp", connections: [], databases: [] })));
  });

  it("keeps an ID-only scope if neither history options nor saved connections know the name", async () => {
    mocks.getConfig.mockReturnValue(undefined);
    const shell = mountShell();
    shell.open({ connectionId: "deleted-connection", database: "analytics" });
    await nextTick();
    await shell.resolve();
    expect(mocks.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connections: [{ connection_id: "deleted-connection", connection_name: "" }],
        databases: [{ connection_id: "deleted-connection", connection_name: "", database: "analytics" }],
      }),
    );
  });
});
