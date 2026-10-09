<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Loader2, ShieldAlert, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { AiAgentStepApproval } from "@/lib/ai/aiAgentStepPresentation";

/** Inline approval for a plugin tool call that may change state. */
const props = defineProps<{ approval: AiAgentStepApproval }>();
const emit = defineEmits<{ resolve: [approved: boolean] }>();

const { t } = useI18n();
const expired = ref(false);

watch(
  () => [props.approval.status, props.approval.expiresAtMs] as const,
  ([status, expiresAtMs], _previous, onCleanup) => {
    expired.value = expiresAtMs <= Date.now();
    if (expired.value || (status !== "pending" && status !== "submitting")) return;
    const timeout = setTimeout(() => {
      expired.value = true;
    }, expiresAtMs - Date.now());
    onCleanup(() => clearTimeout(timeout));
  },
  { immediate: true },
);

const argumentsText = computed(() => JSON.stringify(props.approval.args ?? {}, null, 2));
// A pending card restored from history after its deadline (or an app restart)
// has nobody waiting for the answer anymore.
const waiting = computed(() => (props.approval.status === "pending" || props.approval.status === "submitting") && !expired.value);
const displayStatus = computed(() => (props.approval.status === "pending" || props.approval.status === "submitting" ? "expired" : props.approval.status));
const expiresAt = computed(() => new Date(props.approval.expiresAtMs).toLocaleTimeString());
</script>

<template>
  <div class="space-y-1.5 border-t border-current/10 px-2 pb-2 pt-1.5 text-[10px]" data-ai-tool-approval>
    <div class="flex items-start gap-1.5 text-foreground">
      <ShieldAlert class="mt-px h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
      <span class="min-w-0 wrap-anywhere">{{ t("ai.toolApproval.prompt", { plugin: approval.pluginName, tool: approval.pluginTool, connection: approval.connectionName }) }}</span>
    </div>
    <pre class="max-h-40 overflow-auto rounded bg-background/60 px-2 py-1 font-mono text-[10px] text-foreground/80 whitespace-pre-wrap wrap-anywhere">{{ argumentsText }}</pre>
    <div v-if="waiting" class="flex flex-wrap items-center gap-1.5">
      <Button size="sm" class="h-6 gap-1 px-2 text-[10px]" :disabled="approval.status === 'submitting'" @click="emit('resolve', true)">
        <Loader2 v-if="approval.status === 'submitting'" class="h-3 w-3 animate-spin" />
        <Check v-else class="h-3 w-3" />
        {{ t("ai.toolApproval.approve") }}
      </Button>
      <Button size="sm" variant="outline" class="h-6 gap-1 px-2 text-[10px]" :disabled="approval.status === 'submitting'" @click="emit('resolve', false)">
        <X class="h-3 w-3" />
        {{ t("ai.toolApproval.deny") }}
      </Button>
      <span class="text-muted-foreground">{{ t("ai.toolApproval.expiresAt", { time: expiresAt }) }}</span>
    </div>
    <div v-else class="text-muted-foreground">{{ t(`ai.toolApproval.status.${displayStatus}`) }}</div>
  </div>
</template>
