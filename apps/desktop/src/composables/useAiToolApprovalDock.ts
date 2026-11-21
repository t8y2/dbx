import { computed, ref, watch } from "vue";
import type { AiAgentStepItem } from "@/lib/ai/aiAgentStepPresentation";

/** Visible-conversation approvals only; completed and expired cards stay in history. */
export function useAiToolApprovalDock(messages: () => readonly { agentSteps?: readonly AiAgentStepItem[] }[]) {
  const now = ref(Date.now());
  const candidates = computed(() =>
    messages().flatMap((message) =>
      (message.agentSteps ?? []).flatMap((step) => {
        const approval = step.approval;
        return approval && (approval.status === "pending" || approval.status === "submitting") ? [{ step, expiresAtMs: approval.expiresAtMs }] : [];
      }),
    ),
  );
  // One deadline-driven timer, not a polling loop. Reading status/deadline above
  // also reschedules after retries, conversation switches and new tool calls.
  watch(
    candidates,
    (entries, _old, onCleanup) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        now.value = Date.now();
        const next = Math.min(...entries.map((entry) => entry.expiresAtMs).filter((deadline) => deadline > now.value));
        if (Number.isFinite(next)) timer = setTimeout(tick, Math.min(next - now.value + 1, 2_147_483_647));
      };
      tick();
      onCleanup(() => clearTimeout(timer));
    },
    { immediate: true },
  );
  return computed(() => candidates.value.filter((entry) => entry.expiresAtMs > now.value).map((entry) => entry.step));
}
