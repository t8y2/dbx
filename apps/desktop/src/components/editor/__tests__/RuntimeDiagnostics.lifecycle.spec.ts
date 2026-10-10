// @vitest-environment happy-dom
// Production SFC/service contracts with simulated backend responses, not live database acceptance.
import { compile, createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import toolbarSource from "../../layout/EditorToolbar.vue?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import type { HistoryEntry } from "@/lib/backend/api";
import type { RuntimeDiagnosticRecord } from "@/lib/database/runtimeDiagnostics";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), cancelQuery: vi.fn(), saveHistory: vi.fn(), searchHistory: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connectedIds: new Set(["A", "B"]) }) }));
vi.mock("vue-i18n", () => ({
  useI18n: (options: { messages: Record<string, unknown> }) => ({
    t: (key: string) => key.split(".").reduce((value, part) => (value as Record<string, unknown>)?.[part], options.messages["en-US"]) ?? key,
  }),
}));
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: ["modelValue"],
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
    }),
  };
});
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const pass = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: ["open"],
      emits: ["update:open"],
      setup:
        (props, { slots, emit }) =>
        () =>
          props.open ? h("div", { role: "dialog" }, [h("button", { onClick: () => emit("update:open", false) }, "Close"), slots.default?.()]) : null,
    }),
    DialogContent: pass,
    DialogDescription: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});
import RuntimeDiagnostics from "../RuntimeDiagnostics.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const context = { connectionId: "A", connectionName: "Dedicated A", database: "SYS", engine: "oceanbase-oracle" as const };
function auditRow() {
  return {
    SQL_ID: "0123456789ABCDEF0123456789ABCDEF",
    TRACE_ID: "YB42-0005-0-0",
    TENANT_ID: "1002",
    SVR_IP: "127.0.0.1",
    SVR_PORT: "2882",
    SID: "3221225473",
    REQUEST_ID: "123456789012345678",
    REQUEST_TIME: String(BigInt(Date.now() - 5000) * 1000n),
    RET_CODE: "0",
    ELAPSED_TIME: "4500",
    EXECUTE_TIME: "3100",
    QUEUE_TIME: "0",
    USER_IO_WAIT_TIME: null,
    RETURN_ROWS: "6",
    DISK_READS: "0",
  };
}
function result(row: Record<string, unknown>): QueryResult {
  return { columns: Object.keys(row), rows: [Object.values(row)], affected_rows: 0, execution_time_ms: 0 } as QueryResult;
}
function record(id: string, connectionId = "A"): RuntimeDiagnosticRecord {
  return {
    format: "dbx-runtime-diagnostic-v1",
    id,
    context: { ...context, connectionId },
    engineVersion: null,
    target: {
      kind: "ob_request",
      sqlId: "0123456789ABCDEF0123456789ABCDEF",
      traceId: "YB42-0005-0-0",
      tenantId: "1002",
      serverIp: "127.0.0.1",
      serverPort: "2882",
      sessionId: "3221225473",
      requestId: id.replace(/\D/g, "") || "1",
      requestTimeMicros: "1791589774313222",
      window: { fromMicros: "1791589774000000", toMicros: "1791589775000000" },
    },
    collectedAt: new Date(1791589774000 - Number(id.replace(/\D/g, "") || 0)).toISOString(),
    status: "collected",
    metrics: [],
    evidence: {},
  };
}
function entry(item: RuntimeDiagnosticRecord): HistoryEntry {
  return { id: item.id, connection_id: item.context.connectionId, database: "SYS", sql: "", executed_at: item.collectedAt, execution_time_ms: 0, success: true, operation: "runtime_diagnostic", details_json: JSON.stringify(item) } as HistoryEntry;
}
function mountEntry() {
  const props = reactive({ connection: { id: "A", name: "Dedicated A", db_type: "oceanbase-oracle" } as ConnectionConfig, database: "SYS" });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(defineComponent({ setup: () => () => h(RuntimeDiagnostics, props) }));
  app.mount(host);
  mounted.push({ app, host });
  return { host, props };
}
async function click(host: HTMLElement, name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === name || element.getAttribute("aria-label") === name);
  if (!button) throw new Error(`Missing production button: ${name}`);
  button.click();
  await nextTick();
}
async function open(host: HTMLElement) {
  await click(host, "Runtime diagnostics");
  await vi.waitFor(() => expect(backend.searchHistory).toHaveBeenCalled());
  await nextTick();
}
async function find(host: HTMLElement) {
  const input = host.querySelector<HTMLInputElement>('input:not([type="datetime-local"])')!;
  input.value = "YB42-0005-0-0";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await click(host, "Find request");
}
beforeEach(() => {
  vi.resetAllMocks();
  backend.searchHistory.mockResolvedValue({ entries: [], total: 0 });
  backend.cancelQuery.mockResolvedValue(true);
  backend.saveHistory.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("actual diagnostic SFC backend contracts", () => {
  it.each(["mysql", "postgresql", "sqlserver", "sqlite", "oceanbase-mysql", "dm", "kingbase", "clickhouse"])("the compiled production toolbar does not expose diagnostic collection for %s", async (engine) => {
    const fragment = toolbarSource.match(/<RuntimeDiagnostics\b[^>]*\/>/)?.[0];
    expect(fragment).toBeDefined();
    const render = compile(fragment!);
    const host = document.createElement("div");
    document.body.append(host);
    const props = reactive({ activeConnection: { id: "A", db_type: engine }, activeTab: { database: "SYS" } });
    const app = createApp(defineComponent({ components: { RuntimeDiagnostics }, setup: () => props, render }));
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();
    expect(host.querySelector("button")).toBeNull();
    expect(backend.executeQuery).not.toHaveBeenCalled();
    expect(backend.searchHistory).not.toHaveBeenCalled();
    props.activeConnection.db_type = "oceanbase-oracle";
    await nextTick();
    expect(host.querySelector('button[aria-label="Runtime diagnostics"]')).not.toBeNull();
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });
  it("renders explicit NULL and absent metric as Not collected while preserving a measured zero", async () => {
    const row = auditRow();
    backend.executeQuery.mockImplementation((_connection, _database, sql: string) => Promise.resolve(result(sql.includes("V$VERSION") ? { BANNER: "OceanBase 4.2.5.7" } : sql.includes("GLOBAL_VARIABLE") || sql.includes("OB_PARAMETERS") ? { VALUE: "ON" } : row)));
    const { host } = mountEntry();
    await open(host);
    await find(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Collect and save"));
    await click(host, "Collect and save");
    await vi.waitFor(() => expect(backend.saveHistory).toHaveBeenCalledTimes(1));
    await nextTick();
    const rows = [...host.querySelectorAll("tr")];
    expect(rows.find((r) => r.textContent?.includes("USER_IO_WAIT_TIME"))?.cells[1].textContent).toBe("Not collected");
    expect(rows.find((r) => r.textContent?.includes("TOTAL_WAIT_TIME_MICRO"))?.cells[1].textContent).toBe("Not collected");
    expect(rows.find((r) => r.textContent?.includes("QUEUE_TIME"))?.cells[1].textContent).toBe("0");
    const saved = JSON.parse(backend.saveHistory.mock.calls[0][0].details_json) as RuntimeDiagnosticRecord;
    expect(saved.metrics.find((metric) => metric.name === "user_io_wait")).toMatchObject({ value: null, missingReason: "not_collected" });
    expect(saved.evidence["GV$OB_SQL_AUDIT.TOTAL_WAIT_TIME_MICRO"]).toBeNull();
    expect(saved.metrics.find((metric) => metric.name === "queue")?.value).toBe("0");
  });
  it("uses the actual Load older control for 101 simulated records and forwards the exact cursor", async () => {
    const entries = Array.from({ length: 101 }, (_, index) => entry(record(`page-${index}`)));
    const cursor = { executed_at: entries[99].executed_at, id: entries[99].id };
    backend.searchHistory.mockResolvedValueOnce({ entries: entries.slice(0, 100), total: 101, next_cursor: cursor }).mockResolvedValueOnce({ entries: entries.slice(100), total: 101 });
    const { host } = mountEntry();
    await open(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Load older"));
    await click(host, "Load older");
    await vi.waitFor(() => expect(backend.searchHistory).toHaveBeenCalledTimes(2));
    await nextTick();
    expect(backend.searchHistory.mock.calls[1][0]).toMatchObject({ cursor, limit: 100, connections: [{ connection_id: "A", connection_name: "" }] });
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("· Collected"))).toHaveLength(101));
    expect(host.textContent).not.toContain("Load older");
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });
  it("closing a pending find cancels its execution and ignores the simulated late response after reopening", async () => {
    let resolve!: (value: QueryResult) => void;
    backend.executeQuery.mockImplementation(
      () =>
        new Promise<QueryResult>((done) => {
          resolve = done;
        }),
    );
    const { host } = mountEntry();
    await open(host);
    await find(host);
    expect(host.textContent).toContain("Cancel");
    const executionId = backend.executeQuery.mock.calls[0][4];
    await click(host, "Close");
    await click(host, "Runtime diagnostics");
    resolve(result({ BANNER: "OceanBase 4.2.5.7" }));
    await vi.waitFor(() => expect(backend.cancelQuery).toHaveBeenCalledWith(executionId));
    await nextTick();
    expect(backend.executeQuery).toHaveBeenCalledTimes(1);
    expect(backend.saveHistory).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Collect and save");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("connection switching rejects a simulated delayed history page without replacing the new context", async () => {
    let resolve!: (value: unknown) => void;
    backend.searchHistory
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ entries: [entry(record("new-2", "B"))], total: 1 });
    const { host, props } = mountEntry();
    await open(host);
    props.connection = { ...props.connection, id: "B", name: "Dedicated B" };
    await nextTick();
    await vi.waitFor(() => expect(backend.searchHistory).toHaveBeenCalledTimes(2));
    resolve({ entries: [entry(record("old-1"))], total: 1 });
    await nextTick();
    await nextTick();
    expect(backend.searchHistory.mock.calls[1][0].connections[0].connection_id).toBe("B");
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("· Collected"))).toHaveLength(1));
    expect(host.textContent).toContain("request 2");
    expect(host.textContent).not.toContain("request 1");
    expect(backend.executeQuery).not.toHaveBeenCalled();
  });
  it("switching connection during collection cancels the old read and never saves its late result", async () => {
    const row = auditRow();
    backend.executeQuery.mockImplementation((_connection, _database, sql: string) => Promise.resolve(result(sql.includes("V$VERSION") ? { BANNER: "OceanBase 4.2.5.7" } : sql.includes("GLOBAL_VARIABLE") || sql.includes("OB_PARAMETERS") ? { VALUE: "ON" } : row)));
    const { host, props } = mountEntry();
    await open(host);
    await find(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Collect and save"));
    let resolve!: (value: QueryResult) => void;
    backend.executeQuery.mockImplementationOnce(
      () =>
        new Promise<QueryResult>((done) => {
          resolve = done;
        }),
    );
    await click(host, "Collect and save");
    const executionId = backend.executeQuery.mock.calls.at(-1)![4];
    props.connection = { ...props.connection, id: "B", name: "Dedicated B" };
    await nextTick();
    resolve(result({ BANNER: "OceanBase 4.2.5.7" }));
    await vi.waitFor(() => expect(backend.cancelQuery).toHaveBeenCalledWith(executionId));
    await nextTick();
    expect(backend.saveHistory).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Collect and save");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("a save already in flight retains its original context but cannot insert into the switched view", async () => {
    const row = auditRow();
    backend.executeQuery.mockImplementation((_connection, _database, sql: string) => Promise.resolve(result(sql.includes("V$VERSION") ? { BANNER: "OceanBase 4.2.5.7" } : sql.includes("GLOBAL_VARIABLE") || sql.includes("OB_PARAMETERS") ? { VALUE: "ON" } : row)));
    let resolve!: () => void;
    backend.saveHistory.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { host, props } = mountEntry();
    await open(host);
    await find(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Collect and save"));
    await click(host, "Collect and save");
    await vi.waitFor(() => expect(backend.saveHistory).toHaveBeenCalledTimes(1));
    expect(backend.saveHistory.mock.calls[0][0].connection_id).toBe("A");
    props.connection = { ...props.connection, id: "B", name: "Dedicated B" };
    await nextTick();
    await vi.waitFor(() => expect(backend.searchHistory).toHaveBeenCalledTimes(2));
    resolve();
    await nextTick();
    await nextTick();
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("· Collected"))).toHaveLength(0);
    expect(host.textContent).not.toContain("Record not saved");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
