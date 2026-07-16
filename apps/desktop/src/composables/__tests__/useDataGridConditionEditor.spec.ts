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

function keyboardEvent(key: string) {
  return { key, shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
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
});
