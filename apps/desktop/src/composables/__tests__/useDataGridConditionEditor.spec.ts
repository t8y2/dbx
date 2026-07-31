import { effectScope, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeDataGridConditionQuote, useDataGridConditionEditor } from "@/composables/useDataGridConditionEditor";
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
    expect(editor.highlightedIndex.value).toBe(0);
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("status = customer_name");
  });

  it("builds and applies suggestions at the current caret instead of the value end", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      selectionStart,
      selectionEnd,
      columns: ["customer_id", "customer_name"],
      historyScope: {},
    });

    value.value = "status = cus AND enabled = 1";
    selectionStart.value = 12;
    selectionEnd.value = 12;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["customer_id", "customer_name"]));

    expect(editor.accept(0)).toBe(true);
    expect(value.value).toBe("status = customer_id AND enabled = 1");
    expect(selectionStart.value).toBe(20);
    expect(selectionEnd.value).toBe(20);
  });

  it("uses the current selection as an explicit replacement range", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({ kind: "where", value, selectionStart, selectionEnd, columns: ["old_value"], historyScope: {} });

    value.value = "status = old AND enabled = 1";
    selectionStart.value = 9;
    selectionEnd.value = 12;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["old_value"]));

    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("status = old_value AND enabled = 1");
  });

  it("suggests WHERE connectors after a completed expression", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["account_id", "owner_id"], historyScope: {} });

    value.value = "owner_id = 1 a";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "AND", kind: "keyword" }]));
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("owner_id = 1 AND");
    await nextTick();

    value.value = "owner_id = 1 o";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "OR", kind: "keyword" }]));
  });

  it("suggests fields after a WHERE connector even when the active token is empty", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["account_id", "owner_id"], historyScope: {} });

    value.value = "status = 'active' AND ";
    await nextTick();
    await vi.waitFor(() =>
      expect(editor.suggestions.value).toEqual([
        { value: "account_id", kind: "column" },
        { value: "owner_id", kind: "column" },
      ]),
    );
    expect(editor.accept(1)).toBe(true);
    expect(value.value).toBe("status = 'active' AND owner_id");
  });

  it("does not offer connectors inside quoted values or in ORDER BY", async () => {
    const whereValue = ref("");
    const whereEditor = useDataGridConditionEditor({ kind: "where", value: whereValue, columns: ["name"], historyScope: {} });
    whereValue.value = "name = 'Alice a";
    await nextTick();
    await vi.waitFor(() => expect(whereEditor.suggestions.value).toEqual([]));

    const orderByValue = ref("");
    const orderByEditor = useDataGridConditionEditor({ kind: "orderBy", value: orderByValue, columns: ["amount"], historyScope: {} });
    orderByValue.value = "created_at a";
    await nextTick();
    await vi.waitFor(() => expect(orderByEditor.suggestions.value).toEqual([]));
  });

  it.each(["deleted_at IS ", "deleted_at IS a", "deleted_at IS NOT o", "name LIKE o", "id IN a", "score BETWEEN o"])("does not offer connectors while the keyword operator is incomplete: %s", async (condition) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["account_id"], historyScope: {}, suggestionDebounceMs: 1 });

    value.value = condition;
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);
  });

  it("completes inside dialect quoted identifiers without treating them as strings", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      selectionStart,
      selectionEnd,
      identifierQuote: '"',
      columns: [{ name: "name", insertText: '"name"' }],
      historyScope: {},
    });

    value.value = '"na" = 1';
    selectionStart.value = 3;
    selectionEnd.value = 3;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["name"]));
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe('"name" = 1');
  });

  it("keeps double quotes as string delimiters when the dialect uses another identifier quote", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      selectionStart,
      selectionEnd,
      identifierQuote: "`",
      columns: ["name"],
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    value.value = '"na" = 1';
    selectionStart.value = 3;
    selectionEnd.value = 3;
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);
  });

  it("pairs WHERE quotes, wraps selections, and skips an existing closing quote", () => {
    expect(completeDataGridConditionQuote("id = ", 5, 5, "'")).toEqual({ value: "id = ''", selectionStart: 6, selectionEnd: 6 });
    expect(completeDataGridConditionQuote("name", 0, 4, '"')).toEqual({ value: '"name"', selectionStart: 1, selectionEnd: 5 });
    expect(completeDataGridConditionQuote("id = ''", 6, 6, "'")).toEqual({ value: "id = ''", selectionStart: 7, selectionEnd: 7 });
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

  it.each(["where", "orderBy"] as const)("displays raw PostgreSQL column names but inserts their quoted %s text", async (kind) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind,
      value,
      columns: [{ name: "OrderId", insertText: '"OrderId"', comment: "Mixed-case identifier" }],
      historyScope: {},
    });

    value.value = kind === "where" ? "status = Order" : "created_at DESC, Order";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "OrderId", insertText: '"OrderId"', kind: "column", comment: "Mixed-case identifier" }]));

    expect(editor.accept()).toBe(true);
    expect(value.value).toBe(kind === "where" ? 'status = "OrderId"' : 'created_at DESC, "OrderId"');
  });

  it("restores quoted history verbatim instead of quoting it again", () => {
    const scope = { connectionId: "connection", database: "db", tableName: "orders" };
    rememberDataGridConditionHistory("orderBy", scope, '"OrderId" DESC');
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "orderBy",
      value,
      columns: [{ name: "OrderId", insertText: '"OrderId"' }],
      historyScope: scope,
    });

    editor.openHistory();
    expect(editor.accept(0)).toBe(true);
    expect(value.value).toBe('"OrderId" DESC');
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

  it("passes the cursor text and replacement range to asynchronous providers", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const suggestionProvider = vi.fn(() => ["customer_id"]);
    useDataGridConditionEditor({ kind: "where", value, selectionStart, selectionEnd, historyScope: {}, suggestionProvider });

    value.value = "status = cus AND enabled = 1";
    selectionStart.value = 12;
    selectionEnd.value = 12;
    await nextTick();
    await vi.waitFor(() => expect(suggestionProvider).toHaveBeenCalledOnce());

    expect(suggestionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "status = cus AND enabled = 1",
        valueBeforeCursor: "status = cus",
        token: "cus",
        from: 9,
        to: 12,
        selectionStart: 12,
        selectionEnd: 12,
      }),
    );
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
    const editor = useDataGridConditionEditor({ kind: "orderBy", value, columns: ["name", "namespace"], historyScope: {} });
    value.value = "na";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(2));
    expect(editor.highlightedIndex.value).toBe(-1);

    const initialEnter = keyboardEvent("Enter");
    expect(editor.handleKeydown(initialEnter)).toBe("apply");
    expect(initialEnter.preventDefault).toHaveBeenCalledOnce();
    expect(value.value).toBe("na");

    const down = keyboardEvent("ArrowDown");
    expect(editor.handleKeydown(down)).toBe("navigate");
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(editor.highlightedIndex.value).toBe(0);
    const navigatedEnter = keyboardEvent("Enter");
    expect(editor.handleKeydown(navigatedEnter)).toBe("accept");
    expect(value.value).toBe("name");

    const tabValue = ref("");
    const tabEditor = useDataGridConditionEditor({ kind: "orderBy", value: tabValue, columns: ["name"], historyScope: {} });
    tabValue.value = "na";
    await nextTick();
    await vi.waitFor(() => expect(tabEditor.suggestions.value).toHaveLength(1));
    const tab = keyboardEvent("Tab");
    expect(tabEditor.handleKeydown(tab)).toBe("accept");
    expect(tabValue.value).toBe("name");

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
