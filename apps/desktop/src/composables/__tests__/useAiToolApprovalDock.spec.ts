import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAiToolApprovalDock } from "@/composables/useAiToolApprovalDock";
import type { AiAgentStepItem, AiAgentStepApprovalStatus } from "@/lib/ai/aiAgentStepPresentation";

function step(id: string, status: AiAgentStepApprovalStatus = "pending", expiresAtMs = Date.now() + 1000): AiAgentStepItem {
  return { key: id, tone: "active", labelKey: "tool", approval: { approvalId: id, sessionId: "session", pluginName: "test", pluginTool: "write", connectionName: "test", args: {}, expiresAtMs, status } };
}
const scopes: ReturnType<typeof effectScope>[] = [];
function setup(steps: AiAgentStepItem[]) {
  const messages = ref([{ agentSteps: steps, content: "" }]);
  const scope = effectScope();
  scopes.push(scope);
  const pending = scope.run(() => useAiToolApprovalDock(() => messages.value))!;
  return { messages, pending, scope };
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});
describe("pending approval dock", () => {
  it("retains every live pending/submitting approval but not terminal or expired history", () => {
    const { pending } = setup([step("pending"), step("sending", "submitting"), step("done", "approved"), step("deny", "denied"), step("cancel", "cancelled"), step("timeout", "timed_out"), step("stale", "expired"), step("past", "pending", Date.now() - 1)]);
    expect(pending.value.map((entry) => entry.key)).toEqual(["pending", "sending"]);
  });
  it("does not lose a pending card when the model appends long text or other steps", async () => {
    const { messages, pending } = setup([step("first")]);
    messages.value[0].content += "streamed response ".repeat(1000);
    messages.value[0].agentSteps.push(step("second"));
    await nextTick();
    expect(pending.value.map((entry) => entry.key)).toEqual(["first", "second"]);
    messages.value[0].agentSteps[0].approval!.status = "submitting";
    await nextTick();
    expect(pending.value).toHaveLength(2);
    messages.value[0].agentSteps[0].approval!.status = "approved";
    await nextTick();
    expect(pending.value.map((entry) => entry.key)).toEqual(["second"]);
  });
  it("expires deadlines without another stream event and clears timers on unmount", async () => {
    vi.useFakeTimers();
    const { pending, scope } = setup([step("first"), step("second", "submitting", Date.now() + 2000)]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(pending.value.map((entry) => entry.key)).toEqual(["second"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.value).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("switches conversations and reschedules changed deadlines and retry states", async () => {
    vi.useFakeTimers();
    const { messages, pending, scope } = setup([step("old")]);
    messages.value = [{ agentSteps: [step("new", "submitting", Date.now() + 3000)], content: "" }];
    await nextTick();
    expect(pending.value.map((entry) => entry.key)).toEqual(["new"]);
    messages.value[0].agentSteps[0].approval!.status = "pending";
    messages.value[0].agentSteps[0].approval!.expiresAtMs = Date.now() + 4000;
    await nextTick();
    await vi.advanceTimersByTimeAsync(3001);
    expect(pending.value).toHaveLength(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
