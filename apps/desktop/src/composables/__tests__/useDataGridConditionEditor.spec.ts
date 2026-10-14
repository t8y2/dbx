import { effectScope, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeDataGridConditionQuote, isConditionKeywordSupported, supportsConditionIlike, supportsConditionRegexp, useDataGridConditionEditor } from "@/composables/useDataGridConditionEditor";
import { rememberDataGridConditionHistory } from "@/lib/dataGrid/dataGridConditionHistory";
import type { DatabaseType } from "@/types/database";

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

  it("replaces the active field token and supports clamped keyboard navigation", async () => {
    const value = ref("status = 1 AND cus");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["customer_id", "customer_name"],
      historyScope: {},
    });

    value.value = "status = 1 AND cust";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["customer_id", "customer_name"]));
    expect(editor.highlightedIndex.value).toBe(0);
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.navigate(1)).toBe(true);
    expect(editor.highlightedIndex.value).toBe(1);
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("status = 1 AND customer_name");
  });

  it.each(["cus", "status = 1 AND cus", "NOT cus", "status = 1 AND NOT cus", "(cus", "status = 1 OR (cus", "id BETWEEN 0 AND 1 AND cus", "id NOT BETWEEN 0 AND 1 OR cus", "name = 'BETWEEN' AND cus", "`BETWEEN` = 1 AND cus", "id BETWEEN abs(0) AND 1 AND cus"])(
    "accepts the first WHERE field suggestion directly with Enter: %s",
    async (condition) => {
      const value = ref("");
      const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["customer_id", "customer_name"], historyScope: {} });
      value.value = condition;
      await nextTick();
      await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(2));

      expect(editor.highlightedIndex.value).toBe(0);
      expect(editor.handleKeydown(keyboardEvent("Enter"))).toBe("accept");
      expect(value.value).toBe(condition.replace(/cus$/, "customer_id"));
    },
  );

  it.each(["status = 1 ", "status is", "status IS nu", "status NOT betw"])("applies WHERE conditions without automatically accepting keyword suggestions: %s", async (condition) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["status"], historyScope: {} });
    value.value = condition;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.length).toBeGreaterThan(0));

    expect(editor.suggestions.value[0].kind).toBe("keyword");
    expect(editor.highlightedIndex.value).toBe(-1);
    expect(editor.handleKeydown(keyboardEvent("Enter"))).toBe("apply");
    expect(value.value).toBe(condition);
  });

  it.each([
    "id = 1 + 1",
    "id = - 1",
    "id = + 1",
    "id = 2 * 1",
    "id = 2 / 1",
    "id = (1",
    "id = abs(1",
    "id = coalesce(0, 1",
    "id BETWEEN 0 AND 1",
    "id NOT BETWEEN 0 AND 1",
    "id between 0 and 1",
    "id BETWEEN abs(0) AND 1",
    "id BETWEEN 'AND' AND 1",
    "(id BETWEEN 0 AND 1",
    "id = 2 AND other_id BETWEEN 0 AND 1",
    "id BETWEEN CASE WHEN enabled = 1 AND flag = 1 THEN 0 ELSE 0 END AND 1",
    "id BETWEEN CASE WHEN enabled = 1 OR flag = 1 THEN 0 ELSE 0 END AND 1",
    "id BETWEEN CASE WHEN a = 1 THEN CASE WHEN b = 1 AND c = 1 THEN 0 ELSE 0 END ELSE 0 END AND 1",
  ])("does not rewrite value expressions on Enter: %s", async (condition) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "where", value, columns: ["id", "version1"], historyScope: {} });
    value.value = condition;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "version1", kind: "column" }]));

    expect(editor.highlightedIndex.value).toBe(-1);
    expect(editor.handleKeydown(keyboardEvent("Enter"))).toBe("apply");
    expect(value.value).toBe(condition);
  });

  it("does not suggest column names while typing a value after a comparison operator", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["v_id", "v_name"],
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    // 用户场景：`v_id = v` 时正在输入值，不应该看到列名补全（issue #10595）
    value.value = "v_id = v";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);

    value.value = "v_id <> v";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);

    // AND 之后是字段位置，仍然提示列名
    value.value = "v_id = 'x' AND v";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["v_id", "v_name"]));
  });

  it("does not suggest column names inside an IN value list", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["mi_id", "model_name"],
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    // 用户场景：`v_id = v AND mi_id in (v` —— 正在输入 IN 列表里的值（issue #10595）
    value.value = "v_id = v AND mi_id in (v";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);

    // 列表里的第二个值同样不应提示列名
    value.value = "mi_id in ('a', m";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);

    // 括号闭合后的新条件仍应提示列名
    value.value = "mi_id in (1, 2) AND m";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["mi_id", "model_name"]));

    // 裸括号（表达式开头）仍属于字段位置
    value.value = "(m";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["mi_id", "model_name"]));
  });

  it("only suggests sort direction after an ORDER BY column", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind: "orderBy", value, columns: ["create_time", "create_by"], historyScope: {}, suggestionDebounceMs: 1 });

    // 输入 `asc` 时不应提示列名（否则按 Tab 会把列名写进输入框）
    value.value = "create_time a";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "ASC", kind: "keyword" }]));

    // 逗号之后是新的排序列位置，提示列名
    value.value = "create_time ASC, c";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["create_time", "create_by"]));
  });

  it.each(["where", "orderBy"] as const)("searches %s fields by camel-case initials and any-position text", async (kind) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind, value, columns: ["userProfile", "order_id", "created_at"], historyScope: {} });

    value.value = "up";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["userProfile"]));

    value.value = "id";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["order_id"]));
  });

  it.each(["where", "orderBy"] as const)("hides weaker %s matches when the input exactly matches a field", async (kind) => {
    const value = ref("");
    const editor = useDataGridConditionEditor({ kind, value, columns: ["id", "Is_Di", "Did"], historyScope: {} });

    value.value = "id";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([]));
  });

  it("keeps suggestions dismissed after accepting until the text changes again", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({ kind: "orderBy", value, selectionStart, selectionEnd, columns: ["name", "namespace"], historyScope: {} });

    value.value = "na";
    selectionStart.value = 2;
    selectionEnd.value = 2;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(2));
    editor.navigate(1);
    expect(editor.handleKeydown(keyboardEvent("Enter"))).toBe("accept");
    expect(value.value).toBe("name");
    expect(editor.suggestions.value).toEqual([]);

    selectionStart.value = 2;
    selectionEnd.value = 2;
    await nextTick();
    selectionStart.value = 4;
    selectionEnd.value = 4;
    await nextTick();
    expect(editor.suggestions.value).toEqual([]);

    value.value = "nam";
    selectionStart.value = 3;
    selectionEnd.value = 3;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["name", "namespace"]));
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

    value.value = "status = 1 AND cus AND enabled = 2";
    selectionStart.value = 18;
    selectionEnd.value = 18;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["customer_id", "customer_name"]));

    expect(editor.accept(0)).toBe(true);
    expect(value.value).toBe("status = 1 AND customer_id AND enabled = 2");
    expect(selectionStart.value).toBe(26);
    expect(selectionEnd.value).toBe(26);
  });

  it("uses the current selection as an explicit replacement range", async () => {
    const value = ref("");
    const selectionStart = ref(0);
    const selectionEnd = ref(0);
    const editor = useDataGridConditionEditor({ kind: "where", value, selectionStart, selectionEnd, columns: ["old_value"], historyScope: {} });

    value.value = "old = 1";
    selectionStart.value = 0;
    selectionEnd.value = 3;
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value.map((item) => item.value)).toEqual(["old_value"]));

    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("old_value = 1");
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

  it("does not offer connectors inside quoted values, and offers only sort direction after an ORDER BY column", async () => {
    const whereValue = ref("");
    const whereEditor = useDataGridConditionEditor({ kind: "where", value: whereValue, columns: ["name"], historyScope: {} });
    whereValue.value = "name = 'Alice a";
    await nextTick();
    await vi.waitFor(() => expect(whereEditor.suggestions.value).toEqual([]));

    const orderByValue = ref("");
    const orderByEditor = useDataGridConditionEditor({ kind: "orderBy", value: orderByValue, columns: ["amount"], historyScope: {} });
    orderByValue.value = "created_at a";
    await nextTick();
    // ORDER BY 的排序列之后是排序方向位置：只提示 ASC/DESC，绝不插入列名（issue #10595）
    await vi.waitFor(() => expect(orderByEditor.suggestions.value).toEqual([{ value: "ASC", kind: "keyword" }]));
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

    value.value = kind === "where" ? "status = 1 AND Order" : "created_at DESC, Order";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "OrderId", insertText: '"OrderId"', kind: "column", comment: "Mixed-case identifier" }]));

    expect(editor.accept()).toBe(true);
    expect(value.value).toBe(kind === "where" ? 'status = 1 AND "OrderId"' : 'created_at DESC, "OrderId"');
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

    value.value = "status = 1 AND cus";
    selectionStart.value = 18;
    selectionEnd.value = 18;
    await nextTick();
    await vi.waitFor(() => expect(suggestionProvider).toHaveBeenCalledOnce());

    expect(suggestionProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "status = 1 AND cus",
        valueBeforeCursor: "status = 1 AND cus",
        token: "cus",
        from: 15,
        to: 18,
        selectionStart: 18,
        selectionEnd: 18,
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
    expect(editor.suggestions.value).toEqual([]);

    value.value = "nam";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toHaveLength(2));

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

  it("suggests SQL syntax operators including BETWEEN, LIKE, and IS NULL in WHERE condition (#7989)", async () => {
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["score", "status", "deleted_at"],
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    // 1. 根据 betw 提示 BETWEEN 选项，并展示 BETWEEN ... AND ... 注释
    value.value = "score betw";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "BETWEEN", kind: "keyword", comment: "BETWEEN ... AND ..." }]));
    expect(editor.accept()).toBe(true);
    expect(value.value).toBe("score BETWEEN");

    // 2. 根据 li 提示 LIKE
    value.value = "score li";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "LIKE", kind: "keyword" }]));

    // 3. 根据 is 提示 IS NULL, IS NOT NULL, IS
    value.value = "score is";
    await nextTick();
    await vi.waitFor(() =>
      expect(editor.suggestions.value).toEqual([
        { value: "IS NULL", kind: "keyword" },
        { value: "IS NOT NULL", kind: "keyword" },
      ]),
    );

    // 4. NOT 之后支持提示 BETWEEN 操作符
    value.value = "score not betw";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "BETWEEN", kind: "keyword", comment: "BETWEEN ... AND ..." }]));

    // 5. IS 之后提示 NULL
    value.value = "deleted_at IS nu";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "NULL", kind: "keyword" }]));

    // 6. IS NOT 之后提示 NULL
    value.value = "deleted_at IS NOT nu";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "NULL", kind: "keyword" }]));

    // 7. BETWEEN 第一个操作数之后提示 AND 连接符
    value.value = "score BETWEEN 1 a";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "AND", kind: "keyword" }]));
  });

  it("checks dialect support for ILIKE and REGEXP operators", () => {
    expect(supportsConditionIlike(undefined)).toBe(true);
    expect(supportsConditionIlike("postgres")).toBe(true);
    expect(supportsConditionIlike("duckdb")).toBe(true);
    expect(supportsConditionIlike("clickhouse")).toBe(true);
    expect(supportsConditionIlike("mysql")).toBe(false);
    expect(supportsConditionIlike("sqlserver")).toBe(false);
    expect(supportsConditionIlike("oracle")).toBe(false);
    expect(supportsConditionIlike("sqlite")).toBe(false);

    expect(supportsConditionRegexp(undefined)).toBe(true);
    expect(supportsConditionRegexp("mysql")).toBe(true);
    expect(supportsConditionRegexp("doris")).toBe(true);
    // SQLite parses REGEXP but needs a driver-registered regexp() function DBX does not provide
    expect(supportsConditionRegexp("sqlite")).toBe(false);
    expect(supportsConditionRegexp("turso")).toBe(false);
    expect(supportsConditionRegexp("hive")).toBe(true);
    expect(supportsConditionRegexp("impala")).toBe(true);
    expect(supportsConditionRegexp("postgres")).toBe(false);
    expect(supportsConditionRegexp("sqlserver")).toBe(false);
    expect(supportsConditionRegexp("oracle")).toBe(false);
    expect(supportsConditionRegexp("duckdb")).toBe(false);

    expect(isConditionKeywordSupported("BETWEEN", "mysql")).toBe(true);
    expect(isConditionKeywordSupported("ILIKE", "mysql")).toBe(false);
    expect(isConditionKeywordSupported("ILIKE", "postgres")).toBe(true);
    expect(isConditionKeywordSupported("REGEXP", "mysql")).toBe(true);
    expect(isConditionKeywordSupported("REGEXP", "postgres")).toBe(false);
  });

  it("filters WHERE syntax keywords per dialect and does not suggest EXISTS in operator positions", async () => {
    // 1. MySQL: REGEXP supported, ILIKE not supported, EXISTS not suggested in operator position
    const mysqlValue = ref("");
    const mysqlEditor = useDataGridConditionEditor({
      kind: "where",
      value: mysqlValue,
      columns: ["score", "name"],
      databaseType: "mysql",
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    mysqlValue.value = "score re";
    await nextTick();
    await vi.waitFor(() => expect(mysqlEditor.suggestions.value).toEqual([{ value: "REGEXP", kind: "keyword" }]));

    mysqlValue.value = "score il";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mysqlEditor.suggestions.value).toEqual([]);

    mysqlValue.value = "score ex";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mysqlEditor.suggestions.value).toEqual([]);

    mysqlValue.value = "score not il";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mysqlEditor.suggestions.value).toEqual([]);

    mysqlValue.value = "score not ex";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mysqlEditor.suggestions.value).toEqual([]);

    // 2. SQL Server: neither REGEXP nor ILIKE supported, EXISTS not suggested
    const sqlserverValue = ref("");
    const sqlserverEditor = useDataGridConditionEditor({
      kind: "where",
      value: sqlserverValue,
      columns: ["score", "name"],
      databaseType: "sqlserver",
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    sqlserverValue.value = "score re";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sqlserverEditor.suggestions.value).toEqual([]);

    sqlserverValue.value = "score il";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sqlserverEditor.suggestions.value).toEqual([]);

    sqlserverValue.value = "score ex";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sqlserverEditor.suggestions.value).toEqual([]);

    // 3. PostgreSQL: ILIKE and NOT ILIKE supported, REGEXP not supported as binary keyword
    const pgValue = ref("");
    const pgEditor = useDataGridConditionEditor({
      kind: "where",
      value: pgValue,
      columns: ["score", "name"],
      databaseType: "postgres",
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    pgValue.value = "score re";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pgEditor.suggestions.value).toEqual([]);

    pgValue.value = "score il";
    await nextTick();
    await vi.waitFor(() => expect(pgEditor.suggestions.value).toEqual([{ value: "ILIKE", kind: "keyword" }]));

    // NOT ILIKE is offered after NOT on PostgreSQL
    pgValue.value = "score not il";
    await nextTick();
    await vi.waitFor(() => expect(pgEditor.suggestions.value).toEqual([{ value: "ILIKE", kind: "keyword" }]));

    pgValue.value = "score ex";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pgEditor.suggestions.value).toEqual([]);

    // 4. Dialect-agnostic (undefined): keeps both ILIKE and REGEXP for fallback compatibility
    const genericValue = ref("");
    const genericEditor = useDataGridConditionEditor({
      kind: "where",
      value: genericValue,
      columns: ["score", "name"],
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    genericValue.value = "score re";
    await nextTick();
    await vi.waitFor(() => expect(genericEditor.suggestions.value).toEqual([{ value: "REGEXP", kind: "keyword" }]));

    genericValue.value = "score il";
    await nextTick();
    await vi.waitFor(() => expect(genericEditor.suggestions.value).toEqual([{ value: "ILIKE", kind: "keyword" }]));

    genericValue.value = "score ex";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(genericEditor.suggestions.value).toEqual([]);
  });

  it("reactively updates keyword suggestions when databaseType changes", async () => {
    const dbType = ref<DatabaseType | undefined>("mysql");
    const value = ref("");
    const editor = useDataGridConditionEditor({
      kind: "where",
      value,
      columns: ["score"],
      databaseType: dbType,
      historyScope: {},
      suggestionDebounceMs: 1,
    });

    // MySQL: no ILIKE
    value.value = "score il";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(editor.suggestions.value).toEqual([]);

    // Switch to PostgreSQL: ILIKE becomes available
    dbType.value = "postgres";
    value.value = "score ili";
    await nextTick();
    await vi.waitFor(() => expect(editor.suggestions.value).toEqual([{ value: "ILIKE", kind: "keyword" }]));
  });
});
