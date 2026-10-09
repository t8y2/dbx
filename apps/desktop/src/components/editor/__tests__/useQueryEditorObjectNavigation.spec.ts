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

async function createHarness(overrides: Partial<QueryEditorProps> = {}, semanticCompletionEnabled = false) {
  const props = reactive<QueryEditorProps>({ modelValue: "SELECT * FROM users", databaseType: "postgres", dialect: "postgres", connectionId: "connection", database: "demo", schema: "public", ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const currentView = new EditorView({ parent: host, state: EditorState.create({ doc: props.modelValue }) });
  const position = vi.spyOn(currentView, "posAtCoords").mockReturnValue(props.modelValue.lastIndexOf("users") + 2);
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
  const settings = { editorSettings: { tableHoverLookupMode: "current" } } as Options["settingsStore"];
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
