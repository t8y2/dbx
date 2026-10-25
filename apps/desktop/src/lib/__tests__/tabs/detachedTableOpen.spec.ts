import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { requestDetachedTableOpen } from "@/lib/tabs/detachedTableOpen";
import type { QueryTab } from "@/types/database";

const tauriRuntime = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => tauriRuntime.value }));

function makeTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return reactive({
    id: "tab-1",
    title: "orders",
    connectionId: "conn",
    database: "app",
    mode: "data",
    sql: "",
    isExecuting: false,
    result: undefined,
    ...overrides,
  }) as QueryTab;
}

describe("requestDetachedTableOpen (#13308)", () => {
  it("does nothing outside the Tauri runtime (web gate)", () => {
    tauriRuntime.value = false;
    const dispatch = vi.fn();
    const tab = makeTab({ result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 } });
    requestDetachedTableOpen(() => tab, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    tauriRuntime.value = true;
  });
  it("dispatches immediately when the tab already settled", () => {
    const dispatch = vi.fn();
    const tab = makeTab({ result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 } });
    requestDetachedTableOpen(() => tab, dispatch);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ tabId: "tab-1" });
  });

  it("waits for the first result to land before dispatching", async () => {
    const dispatch = vi.fn();
    const tab = makeTab({ isExecuting: true });
    requestDetachedTableOpen(() => tab, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    tab.isExecuting = false;
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ tabId: "tab-1" });
  });

  it("never dispatches for a vanished tab", async () => {
    const dispatch = vi.fn();
    let tab: QueryTab | undefined = makeTab({ isExecuting: true });
    requestDetachedTableOpen(() => tab, dispatch);
    tab = undefined;
    tab = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
