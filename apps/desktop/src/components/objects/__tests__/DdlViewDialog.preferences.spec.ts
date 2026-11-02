// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DdlViewDialog from "../DdlViewDialog.vue";

const calls = vi.hoisted(() => ({
  load: vi.fn(),
  copy: vi.fn(),
  format: vi.fn(),
  queryStore: { tabs: [] as any[], createTab: vi.fn(), loadDdlViewerTab: vi.fn() },
  settings: { ddlOpenMode: "dialog", refreshDdlOnOpen: false, includeDdlStorage: true, compactDdlSql: false, separateDdlIndexes: false },
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: reactive(calls.settings), updateEditorSettings: (patch: object) => Object.assign(reactive(calls.settings), patch) }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ query_timeout_secs: 20 }) }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => calls.queryStore }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: undefined } }) }));
vi.mock("@/lib/metadata/objectDdlCache", () => ({ loadObjectDdl: calls.load }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: calls.copy }));
vi.mock("@/lib/sql/ddlDisplay", () => ({ ddlFormatDialectFor: () => "plsql", formatDdlForDisplay: calls.format }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/lib/editor/codemirrorSqlDialect", () => ({ createDbxCodeMirrorSqlDialect: () => undefined }));
vi.mock("@/lib/editor/editorClipboardLineEndings", () => ({ editorClipboardLineEndingsExtension: () => [] }));
vi.mock("@/components/editor/EditorSearchPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@codemirror/state", () => ({
  Compartment: class {
    of() {
      return [];
    }
    reconfigure() {
      return [];
    }
  },
  Prec: { highest: () => [] },
  EditorState: { readOnly: { of: () => [] }, allowMultipleSelections: { of: () => [] }, create: (config: any) => ({ doc: { length: config.doc.length, toString: () => config.doc } }) },
}));
vi.mock("@codemirror/view", () => ({
  keymap: { of: () => [] },
  EditorView: class {
    static theme() {
      return [];
    }
    static domEventHandlers() {
      return [];
    }
    state: any;
    element: HTMLTextAreaElement;
    constructor(config: any) {
      this.state = config.state;
      this.element = document.createElement("textarea");
      this.element.value = this.state.doc.toString();
      config.parent.append(this.element);
    }
    dispatch(change: any) {
      if (change.changes) {
        this.element.value = change.changes.insert;
        this.state.doc = { length: this.element.value.length, toString: () => this.element.value };
      }
    }
    focus() {}
    requestMeasure() {}
    destroy() {
      this.element.remove();
    }
  },
}));
vi.mock("@codemirror/lang-sql", () => ({ sql: () => [] }));
vi.mock("@codemirror/search", () => ({ search: () => [] }));
vi.mock("codemirror", () => ({ basicSetup: [] }));

let app: App | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mountDialog(schema = "Owner") {
  const props = reactive({ open: true, connectionId: "oracle-connection", database: "service", schema, tableName: "First", databaseType: "oracle" as const, dialect: "mysql" as const });
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp({ render: () => h(DdlViewDialog, props) });
  app.mount(container);
  return props;
}
async function copyDdl() {
  const button = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("grid.copyDdl"));
  expect(button).toBeDefined();
  button!.click();
  await nextTick();
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(reactive(calls.settings), { ddlOpenMode: "dialog", separateDdlIndexes: false, includeDdlStorage: true, compactDdlSql: false });
  calls.queryStore.tabs.length = 0;
  calls.format.mockImplementation(async (sql: string) => sql);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

it("loads independent indexes only when selected, and copies the selected result", async () => {
  calls.load.mockResolvedValueOnce({ ddl: "CREATE TABLE First (id NUMBER);" }).mockResolvedValueOnce({ ddl: "CREATE TABLE First (id NUMBER);\nCREATE INDEX ix ON First(id);" });
  mountDialog();
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toContain("CREATE TABLE"));
  expect(calls.load.mock.calls[0][0]).toMatchObject({ schema: "Owner", explicitOwner: "Owner", tableName: "First", separateIndexes: false });
  reactive(calls.settings).separateDdlIndexes = true;
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toContain("CREATE INDEX"));
  expect(calls.load.mock.calls[1][0]).toMatchObject({ separateIndexes: true });
  await copyDdl();
  expect(calls.copy).toHaveBeenLastCalledWith("CREATE TABLE First (id NUMBER);\nCREATE INDEX ix ON First(id);");
});

it("ignores an older option response after the newer result is shown", async () => {
  const old = deferred<{ ddl: string }>();
  calls.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ddl: "CREATE INDEX current_index ON First(id);" });
  mountDialog();
  reactive(calls.settings).separateDdlIndexes = true;
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toContain("current_index"));
  old.resolve({ ddl: "STALE" });
  await nextTick();
  await nextTick();
  await copyDdl();
  expect(calls.copy).toHaveBeenLastCalledWith("CREATE INDEX current_index ON First(id);");
});

it("ignores a late formatter result after switching table identity", async () => {
  const oldFormat = deferred<string>();
  calls.load.mockResolvedValue({ ddl: "RAW" });
  calls.format.mockReturnValueOnce(oldFormat.promise).mockResolvedValueOnce("CREATE TABLE Second (id NUMBER);");
  const props = mountDialog();
  await vi.waitFor(() => expect(calls.format).toHaveBeenCalledTimes(1));
  props.tableName = "Second";
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toContain("Second"));
  oldFormat.resolve("STALE FIRST");
  await nextTick();
  await nextTick();
  await copyDdl();
  expect(calls.copy).toHaveBeenLastCalledWith("CREATE TABLE Second (id NUMBER);");
});

it("does not publish a response from the previous open cycle", async () => {
  const old = deferred<{ ddl: string }>();
  calls.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ddl: "CURRENT" });
  const props = mountDialog();
  props.open = false;
  await nextTick();
  props.open = true;
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toBe("CURRENT"));
  old.resolve({ ddl: "STALE" });
  await nextTick();
  await nextTick();
  await copyDdl();
  expect(calls.copy).toHaveBeenLastCalledWith("CURRENT");
});

it("blocks stale copying on failure and lets the user turn independent indexes off to recover", async () => {
  const failed = deferred<{ ddl: string }>();
  calls.load.mockResolvedValueOnce({ ddl: "ORIGINAL" }).mockReturnValueOnce(failed.promise).mockResolvedValueOnce({ ddl: "RECOVERED" });
  mountDialog();
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toBe("ORIGINAL"));
  reactive(calls.settings).separateDdlIndexes = true;
  await nextTick();
  await copyDdl();
  expect(calls.copy).not.toHaveBeenCalled();
  failed.reject(new Error("Index metadata unavailable"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Index metadata unavailable"));
  await copyDdl();
  expect(calls.copy).not.toHaveBeenCalled();
  const option = document.querySelector<HTMLButtonElement>('button[id$="-separateDdlIndexes"]');
  expect(option).not.toBeNull();
  expect(option!.disabled).toBe(false);
  option!.click();
  await vi.waitFor(() => expect(document.querySelector("textarea")?.value).toBe("RECOVERED"));
  expect(calls.load.mock.calls[2][0].separateIndexes).toBe(false);
  await copyDdl();
  expect(calls.copy).toHaveBeenLastCalledWith("RECOVERED");
});

it.each(["service", ""])("keeps explicit owner provenance when opening schema '%s' in a new tab", async (schema) => {
  reactive(calls.settings).ddlOpenMode = "tab";
  calls.queryStore.createTab.mockImplementation(() => {
    calls.queryStore.tabs.push({ id: "ddl" });
    return "ddl";
  });
  mountDialog(schema);
  await vi.waitFor(() => expect(calls.queryStore.loadDdlViewerTab).toHaveBeenCalledWith("ddl"));
  expect(calls.queryStore.tabs[0].ddlViewer).toMatchObject({ schema: "service", explicitOwner: schema || undefined });
});
