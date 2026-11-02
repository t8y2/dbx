<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { copyToClipboard } from "@/lib/common/clipboard";
import { createExecutionConfirmCode, matchesExecutionConfirmCode } from "@/lib/query/executionConfirmCode";
import type { SqlExecutionDangerRequest } from "@/stores/sqlExecutionDangerStore";

/**
 * Confirmation for one multi-database batch. A batch runs the same statement
 * against every data source, so the operator retypes a code that is generated
 * per prompt: a stray click or a held Enter cannot fan a destructive statement
 * out to all connections.
 */
const props = defineProps<{ request: SqlExecutionDangerRequest }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useI18n();

const details = computed(() => {
  const headline = [props.request.targetLabel || props.request.connectionName, props.request.database].filter(Boolean).join(" · ");
  const targets = props.request.targets ?? [];
  if (targets.length <= 1) return headline;
  return [headline, "", t("multiDbExecute.dangerTargets", { count: targets.length }), ...targets.map((target) => `• ${target}`)].join("\n");
});

const message = computed(() => (props.request.kind === "redis" ? t("dangerDialog.redisCommandMessage") : t("dangerDialog.message")));

const code = ref("");
const codeInput = ref("");
const codeCopied = ref(false);
const confirmDisabled = computed(() => !matchesExecutionConfirmCode(codeInput.value, code.value));

// Every prompt gets its own code, and the previous attempt is cleared.
watch(
  () => props.request,
  () => {
    code.value = createExecutionConfirmCode();
    codeInput.value = "";
    codeCopied.value = false;
  },
  { immediate: true },
);

async function copyCode(): Promise<void> {
  await copyToClipboard(code.value);
  codeCopied.value = true;
  window.setTimeout(() => {
    codeCopied.value = false;
  }, 1500);
}
</script>

<template>
  <DangerConfirmDialog
    :open="true"
    :title="t('multiDbExecute.dangerTitle')"
    :message="message"
    :details-text="details"
    :sql="request.sql"
    :confirm-label="t('multiDbExecute.dangerConfirm')"
    :confirm-disabled="confirmDisabled"
    :show-suppress-toggle="false"
    :close-on-confirm="false"
    @update:open="(open) => !open && emit('cancel')"
    @confirm="emit('confirm')"
  >
    <template #options>
      <div class="mb-3 space-y-1.5 rounded-md border bg-muted/20 px-3 py-2.5">
        <div class="flex items-center justify-between gap-2">
          <Label for="multi-db-danger-code" class="text-xs leading-5 text-muted-foreground">{{ t("multiDbExecute.dangerConfirmCodePrompt") }}</Label>
          <Button variant="ghost" size="icon-xs" class="h-6 w-6 text-muted-foreground" :title="t('multiDbExecute.dangerConfirmCodeCopy')" data-multi-db-danger-code-copy @click="copyCode">
            <Check v-if="codeCopied" class="h-3.5 w-3.5 text-emerald-600" />
            <Copy v-else class="h-3.5 w-3.5" />
          </Button>
        </div>
        <p class="font-mono text-lg leading-6 tracking-[0.3em] text-foreground" data-multi-db-danger-code-value>{{ code }}</p>
        <Input id="multi-db-danger-code" v-model="codeInput" data-multi-db-danger-code class="h-8 font-mono tracking-widest" autocomplete="off" spellcheck="false" :placeholder="t('multiDbExecute.dangerConfirmCodePlaceholder')" />
        <!-- The whole batch is answered by this one code, so the instruction
             has to stand out next to the input instead of blending into it. -->
        <p class="text-xs leading-4 font-semibold text-destructive" data-multi-db-danger-code-once>{{ t("multiDbExecute.dangerConfirmCodeOnce") }}</p>
      </div>
    </template>
  </DangerConfirmDialog>
</template>
