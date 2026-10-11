<script setup lang="ts">
// Execution policy editor (ADR §2.5). The mode follows the provider trigger
// declaration; resident mode additionally shows the bounded restart policy.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { defaultExecutionPolicy } from "@/lib/scheduler/schedulerDraft";
import type { TaskExecutionPolicy } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  modelValue: TaskExecutionPolicy;
  disabled?: boolean;
  /** False while the provider trigger pins the mode. */
  modeEditable?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: TaskExecutionPolicy];
}>();

const { t } = useI18n();

const concurrencyOptions = ["forbid", "queue", "replace", "parallel"] as const;
const misfireOptions = ["coalesce", "fire-once", "skip"] as const;
const backoffStrategies = ["fixed", "exponential"] as const;

const isResident = computed(() => props.modelValue.mode === "resident");

function patch(policy: Partial<TaskExecutionPolicy>) {
  emit("update:modelValue", { ...props.modelValue, ...policy });
}

function patchRetry(changes: Partial<TaskExecutionPolicy["retry"]>) {
  patch({ retry: { ...props.modelValue.retry, ...changes } });
}

function patchRestart(changes: Partial<NonNullable<TaskExecutionPolicy["restart"]>>) {
  const restart = props.modelValue.restart ?? defaultExecutionPolicy("resident").restart!;
  patch({ restart: { ...restart, ...changes } });
}

function setTimeoutSeconds(value: string) {
  const parsed = Number(value);
  patch({ timeoutSeconds: value === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : Math.floor(parsed) });
}

function setRestartWindow(value: string) {
  const parsed = Number(value);
  patchRestart({ restartWindowSeconds: value === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : Math.floor(parsed) });
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label>{{ t("scheduler.execution.mode") }}</Label>
        <Select v-if="modeEditable" :model-value="modelValue.mode" :disabled="disabled" @update:model-value="(value: unknown) => typeof value === 'string' && patch(defaultExecutionPolicy(value === 'resident' ? 'resident' : 'run'))">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="run">{{ t("scheduler.execution.modeRun") }}</SelectItem>
            <SelectItem value="resident">{{ t("scheduler.execution.modeResident") }}</SelectItem>
          </SelectContent>
        </Select>
        <div v-else class="flex h-9 items-center gap-2 rounded-md border border-border/70 px-3 text-sm">
          {{ isResident ? t("scheduler.execution.modeResident") : t("scheduler.execution.modeRun") }}
        </div>
      </div>
      <div class="space-y-2">
        <Label>{{ t("scheduler.execution.timeout") }}</Label>
        <Input type="number" min="1" :model-value="modelValue.timeoutSeconds ?? ''" :disabled="disabled" :placeholder="t('scheduler.execution.timeoutNone')" @update:model-value="(value: any) => setTimeoutSeconds(String(value))" />
      </div>
      <div class="space-y-2">
        <Label>{{ t("scheduler.execution.concurrency") }}</Label>
        <Select :model-value="modelValue.concurrency" :disabled="disabled" @update:model-value="(value: unknown) => typeof value === 'string' && patch({ concurrency: value as TaskExecutionPolicy['concurrency'] })">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in concurrencyOptions" :key="option" :value="option">{{ t(`scheduler.execution.concurrency${option[0]!.toUpperCase()}${option.slice(1)}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="space-y-2">
        <Label>{{ t("scheduler.execution.misfire") }}</Label>
        <Select :model-value="modelValue.misfire" :disabled="disabled" @update:model-value="(value: unknown) => typeof value === 'string' && patch({ misfire: value as TaskExecutionPolicy['misfire'] })">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in misfireOptions" :key="option" :value="option">{{ t(`scheduler.execution.misfire${option === "fire-once" ? "FireOnce" : option[0]!.toUpperCase() + option.slice(1)}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <div class="grid gap-4 rounded-md border border-border/70 p-4 sm:grid-cols-3">
      <div class="space-y-2 sm:col-span-3">
        <Label class="text-sm">{{ t("scheduler.execution.retry") }}</Label>
      </div>
      <div class="space-y-2">
        <Label class="text-xs">{{ t("scheduler.execution.maxAttempts") }}</Label>
        <Input type="number" min="1" max="100" :model-value="modelValue.retry.maxAttempts" :disabled="disabled" @update:model-value="(value: unknown) => patchRetry({ maxAttempts: Math.max(1, Math.floor(Number(value) || 1)) })" />
        <p class="text-xs text-muted-foreground">{{ t("scheduler.execution.maxAttemptsHint") }}</p>
      </div>
      <div class="space-y-2">
        <Label class="text-xs">{{ t("scheduler.execution.backoffSeconds") }}</Label>
        <Input type="number" min="0" :model-value="modelValue.retry.backoffSeconds" :disabled="disabled" @update:model-value="(value: unknown) => patchRetry({ backoffSeconds: Math.max(0, Math.floor(Number(value) || 0)) })" />
      </div>
      <div class="space-y-2">
        <Label class="text-xs">{{ t("scheduler.execution.backoffStrategy") }}</Label>
        <Select :model-value="modelValue.retry.backoffStrategy" :disabled="disabled" @update:model-value="(value: unknown) => typeof value === 'string' && patchRetry({ backoffStrategy: value as TaskExecutionPolicy['retry']['backoffStrategy'] })">
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in backoffStrategies" :key="option" :value="option">{{ t(`scheduler.execution.backoff${option[0]!.toUpperCase()}${option.slice(1)}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <div v-if="isResident" class="grid gap-4 rounded-md border border-border/70 p-4 sm:grid-cols-2">
      <div class="space-y-2 sm:col-span-2">
        <div class="flex items-center justify-between gap-4">
          <Label class="text-sm">{{ t("scheduler.execution.restart") }}</Label>
          <Switch :model-value="Boolean(modelValue.restart?.enabled)" :disabled="disabled" @update:model-value="(value: boolean) => patchRestart({ enabled: value })" />
        </div>
      </div>
      <template v-if="modelValue.restart?.enabled">
        <div class="space-y-2">
          <Label class="text-xs">{{ t("scheduler.execution.restartMax") }}</Label>
          <Input type="number" min="0" :model-value="modelValue.restart.maxRestarts" :disabled="disabled" @update:model-value="(value: unknown) => patchRestart({ maxRestarts: Math.max(0, Math.floor(Number(value) || 0)) })" />
        </div>
        <div class="space-y-2">
          <Label class="text-xs">{{ t("scheduler.execution.restartBackoff") }}</Label>
          <Input type="number" min="0" :model-value="modelValue.restart.backoffSeconds" :disabled="disabled" @update:model-value="(value: unknown) => patchRestart({ backoffSeconds: Math.max(0, Math.floor(Number(value) || 0)) })" />
        </div>
        <div class="space-y-2 sm:col-span-2">
          <Label class="text-xs">{{ t("scheduler.execution.restartWindow") }}</Label>
          <Input type="number" min="0" :model-value="modelValue.restart.restartWindowSeconds ?? ''" :disabled="disabled" @update:model-value="(value: any) => setRestartWindow(String(value))" />
          <p class="text-xs text-muted-foreground">{{ t("scheduler.execution.restartWindowHint") }}</p>
        </div>
      </template>
    </div>
  </div>
</template>
