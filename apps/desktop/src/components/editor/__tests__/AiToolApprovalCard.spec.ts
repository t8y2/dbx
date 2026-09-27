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
