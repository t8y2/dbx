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

const ai = vi.hoisted(() => ({
  complete: vi.fn<(...args: unknown[]) => Promise<string>>(),
  init: vi.fn(async () => undefined),
  settings: {
    activeModel: { configId: "test", modelId: "chat-model" },
    editorSettings: { mcpApprovalAi: { configId: "test", modelId: "review-model", autoGenerate: false } },
    aiConfigs: [{ id: "test", provider: "openai", model: "review-model", endpoint: "https://example.invalid", apiKey: "test-key" }],
    isConfigured: true,
  },
}));
vi.mock("@/lib/backend/api", () => ({ aiComplete: ai.complete }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ ...ai.settings, initAiConfigs: ai.init, initEditorSettings: async () => undefined }) }));

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
  DialogContent: {
    inheritAttrs: false,
    setup(_: Record<string, never>, { slots, attrs }: { slots: { default?: () => unknown }; attrs: Record<string, unknown> }) {
      dialogContentAttrs = attrs as Record<string, ((event: { preventDefault: () => void }) => void) | undefined>;
      return () => slots.default?.() ?? null;
    },
  },
  DialogFooter: { template: "<div><slot /></div>" },
  DialogHeader: { template: "<div><slot /></div>" },
  DialogTitle: { template: "<div><slot /></div>" },
}));

import McpSqlApprovalDialog from "../McpSqlApprovalDialog.vue";

let dialogContentAttrs: Record<string, ((event: { preventDefault: () => void }) => void) | undefined> = {};

let host: HTMLDivElement;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  vi.useFakeTimers();
  ai.complete.mockReset().mockResolvedValue(JSON.stringify({ riskLevel: "high", summary: "Removes records.", risks: ["Data loss."] }));
  ai.init.mockReset().mockResolvedValue(undefined);
  ai.settings.isConfigured = true;
  ai.settings.editorSettings.mcpApprovalAi = { configId: "test", modelId: "review-model", autoGenerate: false };
  ai.settings.aiConfigs[0].provider = "openai";
  bridge.handlers = {};
  dialogContentAttrs = {};
  localStorage.clear();
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
            mcpApprovalAiRegenerate: "Regenerate",
            mcpApprovalAiRiskTitle: "Risk rating",
            mcpApprovalAiRisk_low: "Low risk",
            mcpApprovalAiRisk_medium: "Medium risk",
            mcpApprovalAiRisk_high: "High risk",
            mcpApprovalAiRisk_unknown: "Unknown risk",
            mcpApprovalAiExecution: "Execution summary",
            mcpApprovalAiRationale: "Risk explanation",
            mcpApprovalRejectReason: "Rejection reason (optional)",
            mcpApprovalRejectPlaceholder: "Tell the agent why",
            mcpApprovalRejectConfirm: "Confirm rejection",
            mcpApprovalRejectBack: "Back",
            mcpApprovalAiTitle: "AI summary and risks",
            mcpApprovalAiGenerate: "Generate AI summary",
            mcpApprovalAiLoading: "Generating…",
            mcpApprovalAiDisclosure: "Sends the original text to the selected AI service.",
            mcpApprovalAiModel: "Model: {model}",
            mcpApprovalAiTimeout: "Summary timed out. Approval deadline unchanged.",
            mcpApprovalAiConfigure: "Configure an API model. CLI agents are unsupported.",
            mcpApprovalAiFailed: "Summary failed. Please retry.",
            mcpApprovalAiCaution: "Review the complete original text before approving.",
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
            mcpToolApprovalDetail: "Call payload",
            mcpToolApprovalAutoApprove: "Remember this tool and auto-approve its calls for 24 hours",
            mcpApprovalExpires: "Auto-deny in {seconds}s",
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

it.each(["sql", "tool"])("renders the complete long %s payload including its final operation", async (type) => {
  const detail = `${"中文🙂 <script>alert(1)</script>\n".repeat(2_000)}\nDELETE FROM important;`;
  if (type === "sql") {
    bridge.handlers["mcp-sql-approval"]({ payload: { id: "long", connection_name: "Local", database: "app", sql: detail } });
  } else {
    bridge.handlers["mcp-tool-approval"]({ payload: { id: "long", kind: "plugin_tool", tool: "dbx_ssh__exec", detail } });
  }
  await nextTick();
  expect(host.querySelector("pre")?.textContent).toBe(detail);
  expect(host.querySelector("script")).toBeNull();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

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

it("keeps the dialog open on outside clicks or focus moves instead of denying", async () => {
  request("approval-outside");
  await nextTick();
  expect(host.textContent).toContain("DROP TABLE important;");
  for (const key of ["onPointerDownOutside", "onInteractOutside", "onFocusOutside"]) {
    const event = { preventDefault: vi.fn() };
    dialogContentAttrs[key]?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  // No decision was sent and the approval is still on screen.
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(host.textContent).toContain("DROP TABLE important;");
});

it("removes an unanswered request when the desktop approval times out", async () => {
  request("approval-2");
  await nextTick();
  vi.advanceTimersByTime(90_000);
  await nextTick();
  expect(host.textContent).not.toContain("DROP TABLE important;");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("shows a visible countdown and drops the request when it expires", async () => {
  request("approval-cd");
  await nextTick();
  expect(host.querySelector("[data-mcp-approval-remaining]")?.textContent).toContain("Auto-deny in 90s");
  vi.advanceTimersByTime(2000);
  await nextTick();
  expect(host.querySelector("[data-mcp-approval-remaining]")?.textContent).toContain("Auto-deny in 88s");
  vi.advanceTimersByTime(90_000);
  await nextTick();
  expect(host.textContent).not.toContain("DROP TABLE important;");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("auto-approves remembered tools without showing the dialog", async () => {
  localStorage.setItem("dbx.mcp-tool-approval.auto-approve", JSON.stringify([{ tool: "dbx_ssh__exec", until: Date.now() + 60_000 }]));
  toolRequest("tool-auto");
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "tool-auto", decision: "once" });
  expect(host.textContent).not.toContain("Confirm Terminal tool");
});

it("stores a 24h consent when remembering is checked before allowing once", async () => {
  toolRequest("tool-remember");
  await nextTick();
  host.querySelector<HTMLInputElement>("[data-mcp-approval-remember] input")!.click();
  await nextTick();
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Once")
    ?.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "tool-remember", decision: "once" });
  const consents = JSON.parse(localStorage.getItem("dbx.mcp-tool-approval.auto-approve")!) as { tool: string }[];
  expect(consents.map((consent) => consent.tool)).toContain("dbx_ssh__exec");
});

it("confirms high-risk tool calls once only and queues them with SQL approvals", async () => {
  toolRequest("tool-1");
  request("approval-3");
  await nextTick();
  expect(host.textContent).toContain("Confirm Terminal tool");
  expect(host.textContent).toContain("dbx_ssh__exec");
  expect(host.textContent).toContain("rm -rf /tmp/x");
  const labels = Array.from(host.querySelectorAll("button:not([data-mcp-approval-ai-generate])")).map((button) => button.textContent);
  expect(labels).toEqual(["Deny", "Once"]);
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Once")
    ?.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "tool-1", decision: "once" });
  // The queued SQL approval comes next with its timed choices.
  expect(host.textContent).toContain("DROP TABLE important;");
  expect(Array.from(host.querySelectorAll("button:not([data-mcp-approval-ai-generate])")).map((button) => button.textContent)).toContain("One hour");
});

it("offers only a single-call decision under the new SQL confirmation policy", async () => {
  bridge.handlers["mcp-sql-approval"]({ payload: { id: "new-policy", allow_timed: false, connection_name: "Local", database: "app", sql: "DROP TABLE items" } });
  await nextTick();
  expect(Array.from(host.querySelectorAll("button:not([data-mcp-approval-ai-generate])")).map((button) => button.textContent)).toEqual(["Deny", "Once"]);
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
  host.querySelector<HTMLButtonElement>("[data-mcp-rejection-submit]")!.click();
  await nextTick();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: kind, decision: "deny" });
});

async function flushAi() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await nextTick();
}

function generateSummary() {
  host.querySelector<HTMLButtonElement>("[data-mcp-approval-ai-generate]")!.click();
}

it("only sends the full original payload to AI after a click and never approves it", async () => {
  const detail = JSON.stringify({ command: "中文🙂".repeat(5_000) + "; rm -rf /important" });
  bridge.handlers["mcp-tool-approval"]({ payload: { id: "long-ai", kind: "plugin_tool", tool: "dbx_ssh__exec", connection_name: "Local", database: "test", detail } });
  await nextTick();
  expect(ai.init).toHaveBeenCalledOnce();
  expect(ai.complete).not.toHaveBeenCalled();
  generateSummary();
  await flushAi();
  const completion = ai.complete.mock.calls[0][0] as { config: { model: string }; messages: { content: string }[] };
  expect(completion.config.model).toBe("review-model");
  expect(JSON.parse(completion.messages[0].content)).toEqual({ kind: "plugin_tool", tool: "dbx_ssh__exec", connection: "Local", database: "test", original: detail });
  expect(host.querySelector("pre")!.textContent).toBe(detail);
  expect(host.querySelector("[data-mcp-approval-ai-result]")!.textContent).toContain("Data loss");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("keeps AI output as text and preserves the SQL while explaining risks", async () => {
  ai.complete.mockResolvedValue(JSON.stringify({ riskLevel: "high", summary: "<script>alert(1)</script>", risks: ["Data loss"] }));
  request("ai-text");
  await nextTick();
  generateSummary();
  await flushAi();
  expect(host.querySelector("[data-mcp-approval-ai-result]")!.textContent).toContain("<script>");
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector("pre")!.textContent).toBe("DROP TABLE important;");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it.each(["missing", "cli"])("allows manual review when the AI configuration is %s", async (kind) => {
  if (kind === "missing") ai.settings.editorSettings.mcpApprovalAi.configId = "deleted";
  if (kind === "cli") ai.settings.aiConfigs[0].provider = "codex-cli";
  request("no-config");
  await nextTick();
  await flushAi();
  expect(host.querySelector("[data-mcp-approval-ai-generate]")).toBeNull();
  expect(host.textContent).toContain("Configure an API model");
  expect(ai.complete).not.toHaveBeenCalled();
  expect(host.querySelector("pre")!.textContent).toBe("DROP TABLE important;");
  const once = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Once")!;
  once.click();
  await flushAi();
  expect(bridge.invoke).toHaveBeenCalledWith("respond_mcp_sql_approval", { id: "no-config", decision: "once" });
});

it.each(["error", "empty"])("shows a generic retryable failure for %s AI output without resolving the approval", async (kind) => {
  if (kind === "error") ai.complete.mockRejectedValueOnce(new Error("secret-key-sensitive-payload"));
  else ai.complete.mockResolvedValueOnce("   ");
  request("ai-failure");
  await nextTick();
  generateSummary();
  await flushAi();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Summary failed");
  expect(host.textContent).not.toContain("secret-key-sensitive-payload");
  expect(bridge.invoke).not.toHaveBeenCalled();
  generateSummary();
  await flushAi();
  expect(host.querySelector("[data-mcp-approval-ai-result]")!.textContent).toContain("Data loss");
});

it("ignores a late response after a summary timeout and permits retry", async () => {
  let resolveOld!: (value: string) => void;
  ai.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  request("ai-timeout");
  await nextTick();
  generateSummary();
  await flushAi();
  expect(host.querySelector<HTMLButtonElement>("[data-mcp-approval-ai-generate]")!.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);
  await nextTick();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Summary timed out");
  expect(host.textContent).toContain("Auto-deny in 70s");
  generateSummary();
  await flushAi();
  resolveOld("stale unsafe summary");
  await flushAi();
  expect(host.querySelector("[data-mcp-approval-ai-result]")!.textContent).toContain("Data loss");
  expect(host.textContent).not.toContain("stale unsafe summary");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("does not send a delayed configuration load after the summary timeout", async () => {
  let resolveInit!: () => void;
  ai.init.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveInit = resolve;
      }),
  );
  request("ai-init-timeout");
  await nextTick();
  ai.settings.editorSettings.mcpApprovalAi.autoGenerate = true;
  await vi.advanceTimersByTimeAsync(90_001);
  resolveInit();
  await flushAi();
  expect(ai.complete).not.toHaveBeenCalled();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("discards a summary when the user denies that approval and the next request appears", async () => {
  let resolveOld!: (value: string) => void;
  ai.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  request("old-approval");
  toolRequest("next-approval");
  await nextTick();
  generateSummary();
  await flushAi();
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Deny")!
    .click();
  await flushAi();
  host.querySelector<HTMLButtonElement>("[data-mcp-rejection-submit]")!.click();
  await flushAi();
  resolveOld("summary for old approval");
  await flushAi();
  expect(host.textContent).not.toContain("summary for old approval");
  expect(host.querySelector("[data-mcp-approval-ai-result]")).toBeNull();
  expect(host.querySelector("pre")!.textContent).toContain("rm -rf /tmp/x");
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("respond_mcp_sql_approval", { id: "old-approval", decision: "deny" });
});

it("keeps the original approval deadline while AI is pending", async () => {
  let resolveOld!: (value: string) => void;
  ai.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  request("approval-expiration");
  await nextTick();
  await vi.advanceTimersByTimeAsync(80_000);
  generateSummary();
  await flushAi();
  await vi.advanceTimersByTimeAsync(10_001);
  resolveOld("late after expiration");
  await flushAi();
  expect(host.querySelector("pre")).toBeNull();
  expect(host.textContent).not.toContain("late after expiration");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("uses the saved approval model and automatically rates risks only when enabled", async () => {
  ai.settings.editorSettings.mcpApprovalAi.autoGenerate = true;
  request("auto-review");
  await flushAi();
  expect(ai.complete).toHaveBeenCalledOnce();
  const completion = ai.complete.mock.calls[0][0] as { config: { model: string } };
  expect(completion.config.model).toBe("review-model");
  expect(host.querySelector("[data-mcp-approval-risk]")!.textContent).toContain("High risk");
  expect(host.querySelector("[data-mcp-approval-ai-generate]")!.textContent?.trim()).toBe("Regenerate");
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it.each(["sql", "tool"])("returns an optional rejection reason for %s without executing", async (kind) => {
  if (kind === "sql") request("reason");
  else toolRequest("reason");
  await flushAi();
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Deny")!
    .click();
  await nextTick();
  expect(bridge.invoke).not.toHaveBeenCalled();
  const reason = host.querySelector<HTMLTextAreaElement>("[data-mcp-rejection-reason]")!;
  reason.value = "  请先备份，缩小删除范围。  ";
  reason.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  host.querySelector<HTMLButtonElement>("[data-mcp-rejection-submit]")!.click();
  await flushAi();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("respond_mcp_sql_approval", { id: "reason", decision: "deny", reason: "请先备份，缩小删除范围。" });
});

it("lets the user return from rejection without answering or carrying the draft to another request", async () => {
  request("cancel-reject");
  await flushAi();
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Deny")!
    .click();
  await nextTick();
  const reason = host.querySelector<HTMLTextAreaElement>("textarea")!;
  reason.value = "draft reason";
  reason.dispatchEvent(new Event("input", { bubbles: true }));
  Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === "Back")!
    .click();
  await nextTick();
  expect(host.querySelector("textarea")).toBeNull();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it.each(["{bad json", JSON.stringify({ riskLevel: "safe", summary: "Trust me", risks: [] })])("does not display an invalid structured assessment", async (answer) => {
  ai.complete.mockResolvedValue(answer);
  request("bad-structure");
  await nextTick();
  generateSummary();
  await flushAi();
  expect(host.querySelector("[data-mcp-approval-ai-result]")).toBeNull();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Summary failed");
  expect(bridge.invoke).not.toHaveBeenCalled();
});
