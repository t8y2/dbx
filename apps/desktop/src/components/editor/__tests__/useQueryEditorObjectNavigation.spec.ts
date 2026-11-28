// @vitest-environment happy-dom

import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { reactive, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorCodeMirrorRuntime } from "../queryEditorCodeMirrorRuntime";
import { useQueryEditorCompletionMetadata } from "../useQueryEditorCompletionMetadata";
import { useQueryEditorObjectNavigation } from "../useQueryEditorObjectNavigation";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { SqlCompletionColumn, SqlCompletionObject, SqlCompletionTable } from "@/lib/sql/sqlCompletion";

vi.mock("@/stores/connectionStore", () => ({ COMPLETION_METADATA_CONCURRENCY: 4 }));
vi.mock("@/lib/backend/api", () => ({}));
type Options = Parameters<typeof useQueryEditorObjectNavigation>[0];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createHarness(overrides: Partial<QueryEditorProps> = {}, semanticCompletionEnabled = false, tableHoverLookupMode: "current" | "fallback" | "always" = "current") {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT * FROM users", databaseType: "postgres", dialect: "postgres", connectionId: "connection", database: "demo", schema: "public", ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const currentView = new EditorView({ parent: host, state: EditorState.create({ doc: props.modelValue }) });
  const defaultToken = props.modelValue.includes("users") ? "users" : (props.modelValue.match(/[A-Za-z_][\w$]*/g)?.at(-1) ?? "users");
  const position = vi.spyOn(currentView, "posAtCoords").mockReturnValue(Math.max(0, props.modelValue.lastIndexOf(defaultToken)) + Math.min(2, defaultToken.length));
  vi.spyOn(currentView, "focus").mockImplementation(() => {});
  const view = shallowRef<EditorView | null>(currentView);
  const store = {
    getConfig: vi.fn(() => undefined),
    lookupLocalCompletionTables: vi.fn((): SqlCompletionTable[] => []),
    lookupLocalCompletionObjects: vi.fn((): SqlCompletionObject[] => []),
    listCompletionTables: vi.fn(async (): Promise<SqlCompletionTable[]> => []),
    listCompletionObjects: vi.fn(async (): Promise<SqlCompletionObject[]> => []),
    lookupLocalCompletionColumns: vi.fn((): SqlCompletionColumn[] => []),
    listCompletionColumns: vi.fn(async (): Promise<SqlCompletionColumn[]> => []),
  };
  const connectionStore = store as unknown as Options["connectionStore"];
  const metadata = useQueryEditorCompletionMetadata({ props, view, connectionStore, sqlBehaviorDialect: () => props.dialect, maxCompletionTables: 200, remoteLatencyBudgetMs: 40, onDemandMinPrefix: 2, semanticCompletionEnabled });
  const runtime = createQueryEditorCodeMirrorRuntime();
  await runtime.load();
  runtime.setResultSourceRangeEffect = StateEffect.define<{ from: number; to: number } | null>();
  const settings = { editorSettings: { tableHoverLookupMode } } as Options["settingsStore"];
  const emit = vi.fn();
  const dismissHoverTooltip = vi.fn();
  const startEditorSelectionDrag = vi.fn(() => false);
  const navigation = useQueryEditorObjectNavigation({ props, view, editorRef: shallowRef(host), settingsStore: settings, connectionStore, metadata, runtime, dismissHoverTooltip, startEditorSelectionDrag, emit, semanticCompletionEnabled, maxCompletionTables: 200 });
  navigation.attach();
  cleanups.push(() => {
    navigation.dispose();
    currentView.destroy();
    host.remove();
  });
  const event = (overrides: MouseEventInit = {}) => new MouseEvent("mousedown", { ctrlKey: true, button: 0, clientX: 20, clientY: 10, cancelable: true, ...overrides });
  const click = async (overrides: MouseEventInit = {}) => {
    const pointer = event(overrides);
    const handled = navigation.onEditorMouseDown(pointer);
    await vi.advanceTimersByTimeAsync(0);
    return { handled, pointer };
  };
  return { props, view, currentView, position, host, store, metadata, runtime, emit, dismissHoverTooltip, startEditorSelectionDrag, navigation, event, click };
}

describe("QueryEditor object navigation ownership", () => {
  it.each([false, true])("opens a complete MySQL fullwidth table name (semantic=%s)", async (semantic) => {
    const name = "医疗服务项目限年龄（省级）_事后_tab_1";
    const database = "归档库（省级）";
    const modelValue = `SELECT * FROM ${database}.${name} gt1;`;
    const { store, position, emit, click } = await createHarness({ modelValue, databaseType: "mysql", dialect: "mysql", database: "demo", schema: undefined }, semantic);
    position.mockReturnValue(modelValue.lastIndexOf("省级"));
    store.lookupLocalCompletionTables.mockReturnValue([{ name, database, type: "table" }]);
    expect((await click()).handled).toBe(true);
    expect(emit).toHaveBeenCalledWith("clickTable", expect.objectContaining({ name, database }));
    expect(store.lookupLocalCompletionObjects).not.toHaveBeenCalled();
    expect(store.listCompletionObjects).not.toHaveBeenCalled();
  });

  it("gives existing selection dragging priority over object navigation", async () => {
    const harness = await createHarness();
    harness.startEditorSelectionDrag.mockReturnValue(true);
    expect((await harness.click()).handled).toBe(true);
    expect(harness.dismissHoverTooltip).toHaveBeenCalledOnce();
    expect(harness.store.lookupLocalCompletionTables).not.toHaveBeenCalled();
    expect(harness.emit).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true, altKey: true }, { ctrlKey: true, button: 2 }, { ctrlKey: false }])("preserves non-navigation mouse gestures %j", async (modifiers) => {
    const { click, store, emit } = await createHarness();
    expect((await click(modifiers)).handled).toBe(false);
    expect(store.lookupLocalCompletionTables).not.toHaveBeenCalled();
    if (!modifiers.ctrlKey) expect(emit).toHaveBeenCalledWith("closeColumnPanel");
    else expect(emit).not.toHaveBeenCalled();
  });

  it("ignores missing connection contexts and non-identifier positions", async () => {
    const { props, position, click, store } = await createHarness();
    position.mockReturnValue(2);
    expect((await click()).handled).toBe(false);
    position.mockReturnValue(null);
    expect((await click()).handled).toBe(false);
    props.connectionId = undefined;
    expect((await click()).handled).toBe(false);
    expect(store.lookupLocalCompletionTables).not.toHaveBeenCalled();
  });

  it.each(["control", "command"])("opens a cached table with the %s modifier before any routine or remote lookup", async (modifier) => {
    const { store, emit, click } = await createHarness();
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "users", schema: "public", type: "table" }]);
    const result = await click(modifier === "command" ? { ctrlKey: false, metaKey: true } : {});
    expect(result.handled).toBe(true);
    expect(result.pointer.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith("clickTable", expect.objectContaining({ name: "users", schema: "public" }));
    expect(store.lookupLocalCompletionObjects).not.toHaveBeenCalled();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
  });

  it("resolves relation column lists as tables rather than routine calls", async () => {
    const { store, emit, click } = await createHarness({ modelValue: "INSERT INTO users(id) VALUES (1)" });
    store.listCompletionTables.mockResolvedValue([{ name: "users", schema: "public" }]);
    await click();
    expect(store.listCompletionTables).toHaveBeenCalled();
    expect(store.listCompletionObjects).not.toHaveBeenCalled();
    expect(store.lookupLocalCompletionObjects).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("clickTable", expect.objectContaining({ name: "users" }));
  });

  it("opens cached routine metadata without changing its stored identifier case", async () => {
    const { store, position, emit, click } = await createHarness({ modelValue: 'CALL "Cleanup"()', databaseType: "oracle", schema: "APP" });
    position.mockReturnValue(8);
    store.lookupLocalCompletionObjects.mockReturnValue([{ name: "Cleanup", schema: "APP", type: "procedure" }]);
    await click();
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "Cleanup", type: "procedure", nameQuoted: true }), false);
    expect(store.listCompletionObjects).not.toHaveBeenCalled();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
  });

  it("falls back across schemas for unqualified routines in fallback mode", async () => {
    const sql = "CALL cleanup()";
    const { store, position, emit, click } = await createHarness({ modelValue: sql, schema: "public" }, false, "fallback");
    position.mockReturnValue(sql.indexOf("cleanup") + 2);
    store.listCompletionObjects.mockImplementation(async (_connectionId, _database, _filter, _limit, schema, _parent, globalSearch) => {
      if (globalSearch) return [{ name: "cleanup", schema: "reporting", type: "procedure" }];
      if (schema === "public") return [];
      return [];
    });
    await click();
    expect(store.listCompletionObjects).toHaveBeenCalledWith("connection", "demo", "cleanup", 20, "public", undefined, false, "public", ["routine"]);
    expect(store.listCompletionObjects).toHaveBeenCalledWith("connection", "demo", "cleanup", 20, undefined, undefined, true, "public", ["routine"]);
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "cleanup", schema: "reporting", type: "procedure" }), false);
  });

  it("does not cross schemas for unqualified routines in current mode", async () => {
    const sql = "CALL cleanup()";
    const { store, position, emit, click } = await createHarness({ modelValue: sql, schema: "public" }, false, "current");
    position.mockReturnValue(sql.indexOf("cleanup") + 2);
    store.listCompletionObjects.mockResolvedValue([]);
    await click();
    expect(store.listCompletionObjects).toHaveBeenCalledWith("connection", "demo", "cleanup", 20, "public", undefined, false, "public", ["routine"]);
    expect(store.listCompletionObjects.mock.calls.some((call) => call[6] === true)).toBe(false);
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "cleanup", schema: "public", type: "procedure" }), false);
  });

  it("searches all schemas first for unqualified routines in always mode", async () => {
    const sql = "CALL cleanup()";
    const { store, position, emit, click } = await createHarness({ modelValue: sql, schema: "public" }, false, "always");
    position.mockReturnValue(sql.indexOf("cleanup") + 2);
    store.listCompletionObjects.mockResolvedValue([
      { name: "cleanup", schema: "reporting", type: "procedure" },
      { name: "cleanup", schema: "public", type: "procedure" },
    ]);
    await click();
    expect(store.listCompletionObjects).toHaveBeenCalledWith("connection", "demo", "cleanup", 20, undefined, undefined, true, "public", ["routine"]);
    expect(store.listCompletionObjects.mock.calls.some((call) => call[4] === "public" && call[6] === false)).toBe(false);
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "cleanup", schema: "public", type: "procedure" }), false);
  });

  it("keeps qualified routine lookups scoped without global fallback", async () => {
    const sql = "CALL reporting.cleanup()";
    const { store, position, emit, click } = await createHarness({ modelValue: sql, schema: "public" }, false, "fallback");
    position.mockReturnValue(sql.indexOf("cleanup") + 2);
    store.listCompletionObjects.mockImplementation(async (_connectionId, _database, _filter, _limit, schema, parent) => {
      if (schema === "public" && parent === "reporting") return [];
      if (schema === "reporting") return [{ name: "cleanup", schema: "reporting", type: "procedure" }];
      return [];
    });
    await click();
    expect(store.listCompletionObjects.mock.calls.some((call) => call[6] === true)).toBe(false);
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "cleanup", schema: "reporting", type: "procedure" }), false);
  });

  it("jumps to CTE definitions without querying physical table metadata", async () => {
    const sql = "WITH picked AS (SELECT id FROM users) SELECT id FROM picked";
    const { position, currentView, runtime, emit, click, store } = await createHarness({ modelValue: sql }, true);
    position.mockReturnValue(sql.lastIndexOf("picked") + 2);
    const dispatch = vi.spyOn(currentView, "dispatch");
    await click();
    expect(currentView.state.sliceDoc(currentView.state.selection.main.from, currentView.state.selection.main.to)).toBe("picked");
    expect(currentView.state.selection.main.from).toBe(sql.indexOf("picked"));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ effects: expect.arrayContaining([expect.objectContaining({ type: runtime.setResultSourceRangeEffect })]) }));
    expect(store.lookupLocalCompletionTables).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("uses the shared column cache for qualified column navigation", async () => {
    const { position, metadata, store, emit, click } = await createHarness({ modelValue: "SELECT u.name FROM users u" });
    position.mockReturnValue(10);
    metadata.cachedColumnsByTable.set("public.users", [{ name: "name", table: "users", schema: "public" }]);
    await click();
    expect(emit).toHaveBeenCalledWith("clickColumn", [{ name: "name", table: "users", schema: "public" }]);
    expect(store.listCompletionColumns).not.toHaveBeenCalled();
  });

  it("does not emit a false column match when its metadata lookup fails", async () => {
    const { position, store, emit, click } = await createHarness({ modelValue: "SELECT u.name FROM users u" });
    position.mockReturnValue(10);
    store.listCompletionColumns.mockRejectedValue(new Error("offline"));
    await click();
    expect(store.listCompletionColumns).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps modifier-hover lookup bounded and cleans up global listeners", async () => {
    const { navigation, currentView, position, host, event } = await createHarness({ modelValue: " ".repeat(10000) + "users" });
    position.mockReturnValue(10002);
    const stringify = vi.spyOn(currentView.state.doc, "toString");
    expect(navigation.updateTableNavigationHover(currentView, event())).toBe(true);
    expect(host.classList.contains("query-editor--table-navigation-hover")).toBe(true);
    expect(stringify).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup"));
    expect(host.classList.contains("query-editor--table-navigation-hover")).toBe(false);
    navigation.updateTableNavigationHover(currentView, event());
    window.dispatchEvent(new Event("blur"));
    expect(host.classList.contains("query-editor--table-navigation-hover")).toBe(false);
    navigation.dispose();
    navigation.updateTableNavigationHover(currentView, event());
    window.dispatchEvent(new Event("blur"));
    expect(host.classList.contains("query-editor--table-navigation-hover")).toBe(true);
  });
});

describe("Oracle package source navigation", () => {
  const PACKAGE_SPEC = `CREATE OR REPLACE PACKAGE LLMES.BZ_EM_PRO AS
  PROCEDURE BZ_EM_CLEAN_REC_E(V0 STR_ARY_TYPE, IRET OUT VARCHAR2, SRET OUT VARCHAR2);
END BZ_EM_PRO;`;
  const PACKAGE_BODY = `CREATE OR REPLACE PACKAGE BODY LLMES.BZ_EM_PRO AS
  PROCEDURE BZ_EM_CLEAN_REC_S(V0 STR_ARY_TYPE) IS
  BEGIN
    BZ_EM_CLEAN_REC_E(V0);
  END BZ_EM_CLEAN_REC_S;

  PROCEDURE BZ_EM_CLEAN_REC_E(V0 STR_ARY_TYPE) IS
  BEGIN
    NULL;
  END BZ_EM_CLEAN_REC_E;
END BZ_EM_PRO;`;
  const oracleProps = (modelValue: string, objectType: "PACKAGE" | "PACKAGE_BODY") => ({
    modelValue,
    databaseType: "oracle" as const,
    dialect: undefined,
    schema: "LLMES",
    packageSource: { name: "BZ_EM_PRO", schema: "LLMES", objectType },
  });

  it("opens the package body for a spec declaration instead of a missing standalone procedure", async () => {
    const { position, store, emit, click } = await createHarness(oracleProps(PACKAGE_SPEC, "PACKAGE"));
    position.mockReturnValue(PACKAGE_SPEC.indexOf("BZ_EM_CLEAN_REC_E") + 2);
    expect((await click()).handled).toBe(true);
    expect(emit).toHaveBeenCalledWith("openObjectSource", expect.objectContaining({ name: "BZ_EM_CLEAN_REC_E", type: "procedure", parentName: "BZ_EM_PRO", parentSchema: "LLMES" }), false);
    expect(store.listCompletionObjects).not.toHaveBeenCalled();
    expect(store.listCompletionTables).not.toHaveBeenCalled();
  });

  it("jumps to the implementation inside the body without opening another tab", async () => {
    const { position, currentView, emit, click } = await createHarness(oracleProps(PACKAGE_BODY, "PACKAGE_BODY"));
    const call = PACKAGE_BODY.indexOf("BZ_EM_CLEAN_REC_E(V0);");
    position.mockReturnValue(call + 2);
    expect((await click()).handled).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(currentView.state.selection.main.from).toBe(PACKAGE_BODY.indexOf("BZ_EM_CLEAN_REC_E(V0 STR_ARY_TYPE) IS"));
  });

  it("still resolves unrelated identifiers through metadata", async () => {
    const { position, store, emit, click } = await createHarness(oracleProps(PACKAGE_BODY, "PACKAGE_BODY"));
    position.mockReturnValue(PACKAGE_BODY.indexOf("STR_ARY_TYPE") + 2);
    store.lookupLocalCompletionTables.mockReturnValue([{ name: "STR_ARY_TYPE", schema: "LLMES", type: "table" }]);
    await click();
    expect(emit).toHaveBeenCalledWith("clickTable", expect.objectContaining({ name: "STR_ARY_TYPE" }));
  });
});
