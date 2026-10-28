// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: { payload: Record<string, unknown> }) => void>,
  invoke: vi.fn(async () => undefined),
  focus: vi.fn(async () => undefined),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
    bridge.handlers[name] = handler;
    return bridge.unlisten;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFocus: bridge.focus }) }));
vi.mock("@/components/ui/button", () => ({ Button: { template: "<button><slot /></button>" } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: { props: ["open"], template: '<div v-if="open"><slot /></div>' },
  DialogContent: { template: "<div><slot /></div>" },
  DialogFooter: { template: "<div><slot /></div>" },
  DialogHeader: { template: "<div><slot /></div>" },
  DialogTitle: { template: "<div><slot /></div>" },
}));

import McpSqlApprovalDialog from "../McpSqlApprovalDialog.vue";

let host: HTMLDivElement;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  vi.useFakeTimers();
  bridge.handlers = {};
  bridge.invoke.mockClear();
  bridge.focus.mockClear();
  bridge.unlisten.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp(McpSqlApprovalDialog);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          settings: {
            mcpSqlApprovalTitle: "Approve SQL",
            mcpSqlApprovalScope: "Connection: {connection} / {database}",
            mcpSqlApprovalOnce: "Once",
            mcpSqlApprovalHour: "One hour",
            mcpSqlApprovalDay: "One day",
            mcpSqlApprovalDeny: "Deny",
            mcpToolApprovalPluginTitle: "Confirm {plugin} tool",
            mcpToolApprovalGenericTitle: "Confirm high-risk tool call",
            mcpToolApprovalRedisTitle: "Confirm Redis command",
            mcpToolApprovalDescription: "Review the call",
            mcpToolApprovalTool: "Tool",
            mcpToolApprovalTarget: "Target",
          },
        },
      },
    }),
  );
  app.mount(host);
  await Promise.resolve();
});

afterEach(() => {
  app.unmount();
  host.remove();
  vi.useRealTimers();
});

function request(id: string) {
  bridge.handlers["mcp-sql-approval"]?.({ payload: { id, connection_name: "Local", database: "app", sql: "DROP TABLE important;" } });
}

function toolRequest(id: string) {
  bridge.handlers["mcp-tool-approval"]?.({
    payload: { id, kind: "plugin_tool", tool: "dbx_ssh__exec", plugin: "Terminal", connection_name: null, database: null, detail: '{ "command": "rm -rf /tmp/x" }' },
  });
}

it("shows the exact SQL and sends a one-time decision for its request ID", async () => {
  request("approval-1");
  await nextTick();
  expect(host.textContent).toContain("DROP TABLE important;");
  expect(host.textContent).toContain("Local / app");
  expect(bridge.focus).toHaveBeenCalledOnce();
  const once = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Once");
  once?.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "approval-1", decision: "once" });
  expect(host.textContent).not.toContain("DROP TABLE important;");
});

it("removes an unanswered request when the desktop approval times out", async () => {
  request("approval-2");
  await nextTick();
  vi.advanceTimersByTime(90_000);
  await nextTick();
  expect(host.textContent).not.toContain("DROP TABLE important;");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("confirms high-risk tool calls once only and queues them with SQL approvals", async () => {
  toolRequest("tool-1");
  request("approval-3");
  await nextTick();
  expect(host.textContent).toContain("Confirm Terminal tool");
  expect(host.textContent).toContain("dbx_ssh__exec");
  expect(host.textContent).toContain("rm -rf /tmp/x");
  const labels = Array.from(host.querySelectorAll("button")).map((button) => button.textContent);
  expect(labels).toEqual(["Deny", "Once"]);
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Once")
    ?.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "tool-1", decision: "once" });
  // The queued SQL approval comes next with its timed choices.
  expect(host.textContent).toContain("DROP TABLE important;");
  expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).toContain("One hour");
});

it("offers only a single-call decision under the new SQL confirmation policy", async () => {
  bridge.handlers["mcp-sql-approval"]({ payload: { id: "new-policy", allow_timed: false, connection_name: "Local", database: "app", sql: "DROP TABLE items" } });
  await nextTick();
  expect(Array.from(host.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Deny", "Once"]);
  host.querySelector<HTMLButtonElement>("[data-mcp-approval-allow-once]")!.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "new-policy", decision: "once" });
});

it.each(["product_tool", "mongo_command", "connection_management"])("uses a generic title and supports denial for %s", async (kind) => {
  bridge.handlers["mcp-tool-approval"]({ payload: { id: kind, kind, tool: "dbx_example", connection_name: "Local", detail: "Destructive operation" } });
  await nextTick();
  expect(host.textContent).toContain("Confirm high-risk tool call");
  expect(host.textContent).not.toContain("plugin");
  const deny = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Deny")!;
  deny.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: kind, decision: "deny" });
});
