import { effectScope, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridConditionEditor } from "@/composables/useDataGridConditionEditor";
import { rememberDataGridConditionHistory } from "@/lib/dataGrid/dataGridConditionHistory";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
});

function keyboardEvent(key: string, extras: Partial<KeyboardEvent> = {}) {
  return { key, shiftKey: false, preventDefault: vi.fn(), ...extras } as unknown as KeyboardEvent;
}

describe("useDataGridConditionEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("replaces the active token and supports clamped keyboard navigation", async () => {
    const value = ref("status = cus");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["customer_id", "customer_name"],
      historyScope: {},
    });

    value.value = "status = cust";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["customer_id", "customer_name"]));
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("status = customer_name");
  });

  it("reuses column comments for field suggestions without adding them to history", async () => {
    const scope = { connectionId: "connection", database: "db", tableName: "users" };
    rememberDataGridConditionHistory("where", scope, "customer_id = 1");
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: [
        { name: "customer_id", comment: "客户编号" },
        { name: "customer_name", comment: null },
      ],
      historyScope: scope,
    });

    value.value = "cust";
    await nextTick();
    await vi.waitFor(() =>
      expect(editor.suggestions.value).toEqual([
        { value: "customer_id", kind: "column", comment: "客户编号" },
        { value: "customer_name", kind: "column" },
      ]),
    );

    value.value = "customer";
    editor.dismiss();
    editor.openHistory();
    expect(editor.suggestions.value).toEqual([{ value: "customer_id = 1", kind: "history" }]);
  });

  it.each(["where", "orderBy"] as const)("normalizes %s comments from different metadata providers", async (kind) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind,
      value,
      columns: [
        "customer_plain",
        { name: "customer_native", comment: "  原生注释  " },
        { name: "customer_jdbc", comment: "JDBC remarks" },
        { name: "customer_null", comment: null },
        { name: "customer_blank", comment: " \n\t " },
        { name: "customer_invalid", comment: 42 } as unknown as { name: string; comment: string },
      ],
      historyScope: {},
    });

    value.value = "cust";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(6));
    expect(editor.suggestions.value).toEqual([
      { value: "customer_plain", kind: "column" },
      { value: "customer_native", kind: "column", comment: "原生注释" },
      { value: "customer_jdbc", kind: "column", comment: "JDBC remarks" },
      { value: "customer_null", kind: "column" },
      { value: "customer_blank", kind: "column" },
      { value: "customer_invalid", kind: "column" },
    ]);
  });

  it("ignores stale asynchronous suggestion responses", async () => {
    vi.useFakeTimers();
    const value = ref("");
    const resolvers = new Map<string, (values: string[]) => void>();
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      historyScope: {},
      suggestionProvider: ({ token }) => new Promise((resolve) => resolvers.set(token, resolve)),
      suggestionDebounceMs: 10,
    });

    value.value = "cus";
    await nextTick();
    vi.advanceTimersByTime(10);
    await nextTick();
    value.value = "ord";
    await nextTick();
    vi.advanceTimersByTime(10);
    await nextTick();

    resolvers.get("ord")?.(["order_id"]);
    await Promise.resolve();
    expect(editor.suggestions.value.map((item) => item.value)).toEqual(["order_id"]);
    resolvers.get("cus")?.(["customer_id"]);
    await Promise.resolve();
    expect(editor.suggestions.value.map((item) => item.value)).toEqual(["order_id"]);
  });

  it("loads, filters, accepts, and deletes scoped history", () => {
    const scope = { connectionId: "connection", database: "db", tableName: "users" };
    rememberDataGridConditionHistory("where", scope, "status = 'active'");
    rememberDataGridConditionHistory("where", scope, "customer_id > 10");
    const value = ref("status");
    const editor = useDataGridConditionEditor({ kind: "where", value, historyScope: scope });

    editor.openHistory();
    expect(editor.suggestions.value.map((item) => item.value)).toEqual(["status = 'active'"]);
    expect(editor.accept(0)).toBe(true);
    expect(value.value).toBe("status = 'active'");

    editor.openHistory();
    editor.deleteHistory("status = 'active'");
    expect(editor.suggestions.value).toEqual([]);
    expect(editor.historyOpen.value).toBe(true);
  });

  it("aborts pending suggestion work when its scope is disposed", async () => {
    vi.useFakeTimers();
    const value = ref("");
    const aborted = vi.fn();
    const scope = effectScope();
    scope.run(() => {
      useDataGridConditionEditor({
        kind: "orderBy",
        value,
        historyScope: {},
        suggestionDebounceMs: 10,
        suggestionProvider: ({ signal }) => {
          signal.addEventListener("abort", aborted);
          return new Promise(() => {});
        },
      });
    });

    value.value = "created";
    await nextTick();
    vi.advanceTimersByTime(10);
    scope.stop();
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("maps Enter, Tab, arrows, and Escape without applying stale selections", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "orderBy", value, columns: ["name"], historyScope: {} });
    value.value = "na";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(1));

    const down = keyboardEvent("ArrowDown");
    expect(editor.handleKeydown(down)).toBe("navigate");
    expect(down.preventDefault).toHaveBeenCalledOnce();
    const tab = keyboardEvent("Tab");
    expect(editor.handleKeydown(tab)).toBe("accept");
    expect(value.value).toBe("name");

    const enter = keyboardEvent("Enter");
    expect(editor.handleKeydown(enter)).toBe("apply");
    editor.openHistory();
    const escape = keyboardEvent("Escape");
    expect(editor.handleKeydown(escape)).toBe("dismiss");
    expect(editor.dropdownOpen.value).toBe(false);
  });

  it("ignores shortcut keys while an IME composition is active", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["name"], historyScope: {} });
    value.value = "na";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(1));

    const composingEnter = keyboardEvent("Enter", { isComposing: true });
    expect(editor.handleKeydown(composingEnter)).toBeUndefined();
    expect(composingEnter.preventDefault).not.toHaveBeenCalled();
    expect(value.value).toBe("na");

    const processEnter = keyboardEvent("Process");
    expect(editor.handleKeydown(processEnter)).toBeUndefined();
    expect(processEnter.preventDefault).not.toHaveBeenCalled();
  });
});
