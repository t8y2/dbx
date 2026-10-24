<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { oracleCompileUnsupportedReason } from "@/lib/database/oracleInvalidObjects";
import type { OracleTriggerAction, OracleTriggerExecutionResult, OracleTriggerSnapshot } from "@/lib/database/oracleTriggerPlan";

const props = defineProps<{ snapshot?: OracleTriggerSnapshot; result?: OracleTriggerExecutionResult; busy?: boolean; sourceIssue?: string }>();
const emit = defineEmits<{ action: [action: OracleTriggerAction]; parent: []; refresh: []; diagnostics: [] }>();
const { t } = useI18n();
const metadata = computed(() => props.snapshot?.metadata);
const trigger = computed(() => props.snapshot?.raw.trigger);
const compileAvailable = computed(() => !!metadata.value && !oracleCompileUnsupportedReason(metadata.value.engine === "dm" ? "dameng" : metadata.value.engine, "TRIGGER", { triggerProfile: metadata.value }));
const uncertain = computed(() => props.result?.steps.some((step) => step.state === "unknown" || (step.state === "committed" && (step.verification === "mismatch" || step.verification === "unverified"))));
const refused = computed(() => props.result?.steps.some((step) => step.state === "rejected"));
</script>

<template>
  <section v-if="snapshot || sourceIssue || result" class="shrink-0 space-y-2 border-b px-3 py-2 text-sm" data-oracle-trigger-status>
    <div v-if="metadata && snapshot?.exists" class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span
        >{{ t("eventTrigger.owner") }}: <span class="font-mono whitespace-pre-wrap">{{ metadata.owner }}</span></span
      >
      <span>{{ t("eventTrigger.enabled") }}: {{ metadata.reads.enabled?.state === "available" && typeof trigger?.enabled === "boolean" ? t(trigger.enabled ? "objects.enabled" : "objects.disabled") : t("oracleTrigger.unknown") }}</span>
      <span>{{ t("objects.validity") }}: {{ metadata.reads.validity?.state === "available" && typeof trigger?.valid === "boolean" ? (trigger.valid ? "VALID" : "INVALID") : t("oracleTrigger.unknown") }}</span>
      <Button v-if="metadata.parent && (metadata.scope === 'TABLE' || metadata.scope === 'VIEW')" variant="link" size="sm" class="h-auto whitespace-pre-wrap p-0 font-mono" :disabled="metadata.reads.parent?.state !== 'available'" @click="emit('parent')"
        >{{ metadata.parent.owner }}.{{ metadata.parent.name }} · {{ metadata.parent.objectType }}</Button
      >
      <span v-else class="font-mono whitespace-pre-wrap">{{ metadata.scope }}{{ metadata.scopeOwner ? ` · ${metadata.scopeOwner}` : "" }}</span>
      <div class="ml-auto flex flex-wrap gap-1">
        <Button v-if="trigger?.valid === false || metadata.errors?.length" variant="outline" size="sm" :disabled="busy" @click="emit('diagnostics')">{{ t("processList.oracleInvalidObjects.errorsTitle") }}</Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="emit('action', 'enable')">{{ t("contextMenu.enableTrigger") }}</Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="emit('action', 'disable')">{{ t("contextMenu.disableTrigger") }}</Button>
        <Button v-if="compileAvailable" variant="outline" size="sm" :disabled="busy" @click="emit('action', 'compile')">{{ t("processList.oracleInvalidObjects.compile") }}</Button>
      </div>
    </div>
    <p v-if="sourceIssue" role="alert" class="whitespace-pre-wrap break-words text-muted-foreground">{{ sourceIssue }}</p>
    <div v-if="result && !result.cancelled" aria-live="polite" class="space-y-1">
      <p v-for="(step, index) in result.steps" :key="index" class="break-words" :class="step.state !== 'committed' || step.verification === 'invalid' ? 'text-destructive' : 'text-muted-foreground'">
        {{ t(`oceanbasePrimaryKey.${step.state}`) }}
        <template v-if="step.verification !== 'applied'">
          · {{ step.verification === "valid" ? "VALID" : step.verification === "invalid" ? "INVALID" : step.verification === "deleted" ? t("processList.oracleInvalidObjects.batchStatus.deleted") : t("oracleStructureResult.readbackFailed") }}
        </template>
        <span v-if="step.error || step.readbackError" class="block whitespace-pre-wrap">{{ [step.error, step.readbackError].filter(Boolean).join("\n") }}</span>
      </p>
      <p v-if="uncertain" role="alert" class="text-destructive">{{ t("oracleSecurity.writeUnknown") }}</p>
      <p v-else-if="refused" role="alert" class="text-destructive">{{ t("oracleSecurity.writeRejected") }}</p>
      <p v-if="result.refreshError" role="alert" class="whitespace-pre-wrap text-destructive">{{ result.refreshError }}</p>
      <Button v-if="uncertain || refused || result.refreshError" variant="outline" size="sm" :disabled="busy" @click="emit('refresh')">{{ t("oracleTrigger.verifyReadOnly") }}</Button>
    </div>
    <div v-if="metadata && metadata.reads.errors?.state !== 'available'" class="text-muted-foreground">
      {{
        metadata.reads.errors?.state === "incomplete"
          ? t("processList.oracleInvalidObjects.errorsTruncated")
          : `${t("processList.oracleInvalidObjects.errorsTitle")}: ${t(`oracleSecurity.${metadata.reads.errors?.state === "denied" ? "denied" : metadata.reads.errors?.state === "error" ? "error" : "unavailable"}`)}`
      }}
    </div>
    <ol v-if="metadata?.errors?.length" class="max-h-28 overflow-auto space-y-1 font-mono text-xs text-destructive" :aria-label="t('processList.oracleInvalidObjects.errorsTitle')">
      <li v-for="(error, index) in metadata.errors" :key="index">{{ error.line ?? "?" }}:{{ error.position ?? "?" }} {{ error.text }}</li>
    </ol>
  </section>
</template>
