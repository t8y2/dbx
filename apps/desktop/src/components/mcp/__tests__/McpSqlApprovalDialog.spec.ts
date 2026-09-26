// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: { id: string; connection_name: string; database: string; sql: string } }) => void),
  invoke: vi.fn(async () => undefined),
  focus: vi.fn(async () => undefined),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: typeof bridge.handler) => {
    bridge.handler = handler;
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
  bridge.handler = null;
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
  bridge.handler?.({ payload: { id, connection_name: "Local", database: "app", sql: "DROP TABLE important;" } });
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
