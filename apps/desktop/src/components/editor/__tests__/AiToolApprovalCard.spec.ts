// @vitest-environment happy-dom

import { createApp, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import AiToolApprovalCard from "../AiToolApprovalCard.vue";
import type { AiAgentStepApproval } from "@/lib/ai/aiAgentStepPresentation";

const cleanups: Array<() => void> = [];

function mountCard() {
  const approval = reactive<AiAgentStepApproval>({ approvalId: "approval", sessionId: "session", pluginName: "Plugin", pluginTool: "write", connectionName: "Connection", args: { target: "orders" }, expiresAtMs: Date.now() + 1000, status: "pending" });
  const onResolve = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(AiToolApprovalCard, { approval, onResolve });
  app.use(i18n);
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  return { approval, onResolve, container };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.useRealTimers();
});

describe("AiToolApprovalCard", () => {
  it("expires without another backend event and removes its answer buttons", async () => {
    vi.useFakeTimers();
    const { container, onResolve } = mountCard();
    expect(container.querySelectorAll("button")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1001);
    await nextTick();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain(i18n.global.t("ai.toolApproval.status.expired"));
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("forwards one-time approval and disables both buttons while submitting", async () => {
    const { container, approval, onResolve } = mountCard();
    container.querySelector("button")?.click();
    expect(onResolve).toHaveBeenCalledWith(true);
    approval.status = "submitting";
    await nextTick();
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    approval.status = "denied";
    await nextTick();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain(i18n.global.t("ai.toolApproval.status.denied"));
  });
});

describe("command previews (#13855)", () => {
  it("shows the exact command first and keeps the full arguments available", async () => {
    const { container, approval } = mountCard();
    approval.args = { command: "printf '<hello>\\n'", cwd: "/tmp", timeout: 30 };
    await nextTick();
    const preview = container.querySelector("[data-ai-tool-approval-command]");
    expect(preview?.textContent).toBe(approval.args.command);
    expect(preview?.querySelector("hello")).toBeNull();
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('"cwd": "/tmp"');
    expect(details?.textContent).toContain('"timeout": 30');
  });
  it("keeps JSON visible for tools without a non-empty string command", async () => {
    const { container, approval } = mountCard();
    for (const command of [undefined, "", "   ", ["echo", "hello"]]) {
      approval.args = { command, target: "orders" };
      await nextTick();
      expect(container.querySelector("[data-ai-tool-approval-command]")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toContain('"target": "orders"');
    }
  });
});
