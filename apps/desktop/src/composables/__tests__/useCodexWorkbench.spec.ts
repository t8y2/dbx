import { expect, it, vi } from "vitest";
import { createCodexIntentHandler } from "@/composables/useCodexWorkbench";

it("displays the original result once without executing SQL", async () => {
  const results = [{ columns: ["value"], rows: [["x".repeat(4000)]], affected_rows: 1 }];
  const read = vi.fn().mockResolvedValue({ kind: "result", connection_id: "c", database: "d", sql: "SELECT value", results });
  const showResults = vi.fn();
  const openTable = vi.fn();
  const handle = createCodexIntentHandler({ read, showResults, openTable });
  await Promise.all([handle("http://localhost/?codex_intent=a"), handle("http://localhost/?codex_intent=a")]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(showResults).toHaveBeenCalledExactlyOnceWith("c", "d", "SELECT value", results);
  expect(openTable).not.toHaveBeenCalled();
});

it("opens the selected schema and table after login and retries a failed read", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("Unauthorized")).mockResolvedValue({ kind: "table", connection_id: "c", database: "d", schema: "s", table: "t" });
  const openTable = vi.fn();
  const showResults = vi.fn();
  const handle = createCodexIntentHandler({ read, showResults, openTable });
  await expect(handle("http://localhost/?codex_intent=b")).rejects.toThrow("Unauthorized");
  await handle("http://localhost/?codex_intent=b");
  expect(openTable).toHaveBeenCalledExactlyOnceWith({ connectionId: "c", database: "d", schema: "s", tableName: "t" });
  expect(showResults).not.toHaveBeenCalled();
});

it("does nothing for a normal workbench URL", async () => {
  const read = vi.fn();
  await createCodexIntentHandler({ read, showResults: vi.fn(), openTable: vi.fn() })("http://localhost/");
  expect(read).not.toHaveBeenCalled();
});

it("populates an actual query tab with the original long cells and multiple result sets", async () => {
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  const { useQueryStore } = await import("@/stores/queryStore");
  const store = useQueryStore();
  const results = [
    { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 },
    { columns: ["value"], rows: [["private cell ".repeat(400)]], affected_rows: 0, execution_time_ms: 2 },
  ];
  const handle = createCodexIntentHandler({
    read: vi.fn().mockResolvedValue({ kind: "result", connection_id: "c", database: "d", sql: "INSERT; SELECT", results }),
    openTable: vi.fn(),
    showResults: store.showExecutedQueryResults,
  });
  await handle("http://localhost/?codex_intent=original");
  const tab = store.tabs.find((tab) => tab.id === store.activeTabId)!;
  expect(tab.results).toEqual(results);
  expect(tab.result).toEqual(results[1]);
  expect(tab.activeResultIndex).toBe(1);
  expect(tab.lastExecutedSql).toBe("INSERT; SELECT");
  expect(tab.isExecuting).toBe(false);
  expect(tab.resultViewGeneration).toBeTruthy();
}, 30_000);
