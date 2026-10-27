// @vitest-environment happy-dom
import { createApp, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import { PG_ADMIN_CONTEXT_SQL, PG_BLOCKING_SQL } from "@/lib/database/postgresLocks";
import { postgresSystemInfoSql } from "@/lib/database/postgresSystemInfo";
const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  closeClientConnectionSession: vi.fn().mockResolvedValue(true),
  listDatabases: vi.fn().mockResolvedValue([{ name: "smart" }, { name: "other" }]),
  toast: vi.fn(),
  createTab: vi.fn(),
  openProcessList: vi.fn(),
  guard: vi.fn(),
  connectedIds: new Set(["pg"]),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connectedIds: mocks.connectedIds }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
import PostgresLocksPanel from "../PostgresLocksPanel.vue";
import PostgresSystemInfoPanel from "../PostgresSystemInfoPanel.vue";
const config = { id: "pg", name: "PG", db_type: "postgres", username: "viewer", database: "smart" } as ConnectionConfig;
function result(record: Record<string, unknown>): QueryResult {
  return { columns: Object.keys(record), rows: [Object.values(record)], affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
const blocking = () =>
  result({
    wait_pid: 21,
    hold_pid: 22,
    wait_backend_start: "2026-10-27 12:00:00.123456+00",
    hold_backend_start: "2026-10-27 11:00:00.123456+00",
    wait_query_start: "2026-10-27 13:00:00+00",
    wait_user: "app",
    hold_user: "worker",
    wait_database: "smart",
    hold_database: "smart",
    wait_query: "UPDATE sample SET value=2",
    hold_query: "UPDATE sample SET value=1",
  });
let app: ReturnType<typeof createApp> | null = null;
let root: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectedIds.add("pg");
  mocks.guard.mockImplementation((options) => options.execute());
  mocks.executeQuery.mockImplementation(async (_id: string, _db: string, sql: string) => {
    if (sql === PG_ADMIN_CONTEXT_SQL) return result({ version: 180000, pid: 9, database: "smart" });
    if (sql === PG_BLOCKING_SQL) return blocking();
    if (sql.startsWith("SELECT pg_cancel_backend") || sql.startsWith("SELECT pg_terminate_backend")) return result({ accepted: true });
    return result({ name: "fixture" });
  });
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  app?.unmount();
  app = null;
  root.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
async function mountLocks() {
  app = createApp(PostgresLocksPanel, { connection: config });
  app.mount(root);
  await vi.waitFor(() => expect(root.textContent).toContain("UPDATE sample SET value=2"));
}
function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
}
async function select() {
  root.querySelector<HTMLTableRowElement>("tr[tabindex]")!.click();
  await nextTick();
}
describe("PostgreSQL locks panel", () => {
  it("loads both sides through a stable session and releases it when closed", async () => {
    await mountLocks();
    await select();
    await vi.waitFor(() => expect(root.textContent).toContain("fixture"));
    const calls = mocks.executeQuery.mock.calls;
    expect(calls.length).toBe(4);
    const ids = calls.map((call) => call[5].clientSessionId);
    expect(new Set(ids).size).toBe(1);
    app!.unmount();
    app = null;
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("pg", "smart", ids[0]);
  });
  it("requires confirmation, uses the connection mutation guard, and validates the server signal", async () => {
    await mountLocks();
    await select();
    click("postgresAdmin.cancel");
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("SELECT pg_cancel_backend"))).toBe(false);
    click("postgresAdmin.confirmButton");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("postgresAdmin.done", 2500));
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ scope: "connection", connection: config }));
    expect(mocks.executeQuery).toHaveBeenCalledWith("pg", "smart", expect.stringContaining("backend_start::text = '2026-10-27 12:00:00.123456+00'"), undefined, undefined, expect.objectContaining({ maxRows: 1 }));
  });
  it("does not dispatch a signal when production confirmation is declined", async () => {
    mocks.guard.mockResolvedValue(undefined);
    await mountLocks();
    await select();
    click("postgresAdmin.terminate");
    await nextTick();
    click("postgresAdmin.confirmButton");
    await vi.waitFor(() => expect(mocks.guard).toHaveBeenCalled());
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("SELECT pg_terminate_backend"))).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalledWith("postgresAdmin.done", 2500);
  });
  it("refuses a wait which resolved while confirmation was open", async () => {
    await mountLocks();
    await select();
    click("postgresAdmin.terminate");
    await nextTick();
    const impl = mocks.executeQuery.getMockImplementation()!;
    mocks.executeQuery.mockImplementation((...args) => (args[2] === PG_BLOCKING_SQL ? Promise.resolve({ columns: [], rows: [] }) : impl(...args)));
    click("postgresAdmin.confirmButton");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("postgresAdmin.targetChanged"), 5000));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("SELECT pg_terminate_backend"))).toBe(false);
  });
  it("preserves a prepared transaction blocker and disables its terminate action", async () => {
    const impl = mocks.executeQuery.getMockImplementation()!;
    mocks.executeQuery.mockImplementation((...args) => (args[2] === PG_BLOCKING_SQL ? Promise.resolve(result({ ...Object.fromEntries(blocking().columns.map((key, i) => [key, blocking().rows[0][i]])), hold_pid: 0, hold_backend_start: null })) : impl(...args)));
    await mountLocks();
    await select();
    const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "postgresAdmin.terminateBlocker");
    expect(button?.disabled).toBe(true);
    expect(root.textContent).toContain("postgresAdmin.prepared");
  });
  it("reports unsupported versions without querying missing functions", async () => {
    mocks.executeQuery.mockResolvedValue(result({ version: 90500, pid: 9 }));
    app = createApp(PostgresLocksPanel, { connection: config });
    app.mount(root);
    await vi.waitFor(() => expect(root.textContent).toContain("postgresAdmin.oldVersion"));
    expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
  });
  it("invalidates actions after a failed refresh", async () => {
    await mountLocks();
    await select();
    mocks.executeQuery.mockRejectedValue(new Error("Network failed"));
    click("postgresAdmin.refresh");
    await vi.waitFor(() => expect(root.textContent).toContain("Network failed"));
    expect(root.querySelector("tr[tabindex]")).toBeNull();
    expect(root.textContent).not.toContain("postgresAdmin.terminateBlocker");
  });
});
describe("PostgreSQL system information", () => {
  it("queries the chosen category and bank, and never executes monitoring SQL merely by opening its editor", async () => {
    app = createApp(PostgresSystemInfoPanel, { connection: config, category: "extensions" });
    app.mount(root);
    await vi.waitFor(() => expect(root.textContent).toContain("fixture"));
    expect(mocks.executeQuery).toHaveBeenCalledWith("pg", "smart", postgresSystemInfoSql("extensions"), undefined, undefined, expect.anything());
    click("postgresAdmin.showSql");
    expect(mocks.createTab).toHaveBeenCalledWith("pg", "smart", undefined, "query", undefined, postgresSystemInfoSql("extensions"));
    const select = root.querySelector("select")!;
    select.value = "other";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("pg", "other", postgresSystemInfoSql("extensions"), undefined, undefined, expect.anything()));
  });
  it("ignores a late category response", async () => {
    let finish!: (value: QueryResult) => void;
    mocks.executeQuery.mockReturnValueOnce(
      new Promise<QueryResult>((resolve) => {
        finish = resolve;
      }),
    );
    const props = reactive({ connection: config, category: "collations" as "collations" | "languages" });
    app = createApp({ render: () => null });
    const { h } = await import("vue");
    app = createApp({ setup: () => () => h(PostgresSystemInfoPanel, props) });
    app.mount(root);
    await nextTick();
    props.category = "languages";
    await vi.waitFor(() => expect(root.textContent).toContain("fixture"));
    finish(result({ name: "old-collation" }));
    await nextTick();
    await nextTick();
    expect(root.textContent).not.toContain("old-collation");
  });
});
