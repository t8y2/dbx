<script setup lang="ts">
// Trigger editor: manual / once / interval / cron / startup. Once and cron
// carry an IANA time zone that is persisted with the task (ADR §2.4) — the UI
// defaults it to the OS zone and never recomputes fire times locally.
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TASK_TRIGGER_TYPES, defaultTrigger } from "@/lib/scheduler/schedulerDraft";
import { defaultTimeZone } from "@/lib/scheduler/schedulerProviders";
import type { TaskTrigger, TaskTriggerType } from "@/lib/scheduler/schedulerTypes";

const props = defineProps<{
  modelValue: TaskTrigger;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: TaskTrigger];
}>();

const { t } = useI18n();

const typeOptions = computed(() =>
  TASK_TRIGGER_TYPES.map((type) => ({
    value: type,
    label: t(`scheduler.trigger.${type}`),
  })),
);

function setType(type: TaskTriggerType) {
  if (props.modelValue.type === type) return;
  const next = defaultTrigger(type);
  // Keep the chosen zone when switching between zone-bearing types.
  if ((props.modelValue.type === "once" || props.modelValue.type === "cron") && (next.type === "once" || next.type === "cron")) {
    next.timeZone = props.modelValue.timeZone || defaultTimeZone();
  }
  emit("update:modelValue", next);
}

const currentType = computed<TaskTriggerType>(() => props.modelValue.type);

function patchTrigger(patch: Partial<TaskTrigger>) {
  emit("update:modelValue", { ...props.modelValue, ...patch } as TaskTrigger);
}
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <div class="space-y-2">
      <Label>{{ t("scheduler.trigger.type") }}</Label>
      <Select :model-value="currentType" :disabled="disabled" @update:model-value="(value: unknown) => typeof value === 'string' && setType(value as TaskTriggerType)">
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <template v-if="currentType === 'once'">
      <div class="space-y-2">
        <Label>{{ t("scheduler.trigger.at") }}</Label>
        <Input type="datetime-local" :model-value="modelValue.type === 'once' ? modelValue.at.slice(0, 16) : ''" :disabled="disabled" data-scheduler-trigger-at @update:model-value="(value: unknown) => typeof value === 'string' && patchTrigger({ at: value })" />
      </div>
      <div class="space-y-2 sm:col-span-2">
        <Label>{{ t("scheduler.trigger.timeZone") }}</Label>
        <Input :model-value="modelValue.type === 'once' ? modelValue.timeZone : ''" :disabled="disabled" :placeholder="defaultTimeZone()" data-scheduler-trigger-timezone @update:model-value="(value: unknown) => typeof value === 'string' && patchTrigger({ timeZone: value })" />
        <p class="text-xs text-muted-foreground">{{ t("scheduler.trigger.timeZoneHint") }}</p>
      </div>
    </template>

    <template v-else-if="currentType === 'interval'">
      <div class="space-y-2">
        <Label>{{ t("scheduler.trigger.seconds") }}</Label>
        <Input type="number" min="1" :model-value="modelValue.type === 'interval' ? modelValue.seconds : 3600" :disabled="disabled" data-scheduler-trigger-interval @update:model-value="(value: unknown) => patchTrigger({ seconds: Math.max(1, Number(value) || 1) })" />
        <p class="text-xs text-muted-foreground">{{ t("scheduler.trigger.secondsHint") }}</p>
      </div>
    </template>

    <template v-else-if="currentType === 'cron'">
      <div class="space-y-2">
        <Label>{{ t("scheduler.trigger.expression") }}</Label>
        <Input :model-value="modelValue.type === 'cron' ? modelValue.expression : ''" :disabled="disabled" placeholder="0 2 * * *" data-scheduler-trigger-expression @update:model-value="(value: unknown) => typeof value === 'string' && patchTrigger({ expression: value })" />
        <p class="text-xs text-muted-foreground">{{ t("scheduler.trigger.expressionHint") }}</p>
      </div>
      <div class="space-y-2">
        <Label>{{ t("scheduler.trigger.timeZone") }}</Label>
        <Input :model-value="modelValue.type === 'cron' ? modelValue.timeZone : ''" :disabled="disabled" :placeholder="defaultTimeZone()" data-scheduler-trigger-timezone @update:model-value="(value: unknown) => typeof value === 'string' && patchTrigger({ timeZone: value })" />
        <p class="text-xs text-muted-foreground">{{ t("scheduler.trigger.timeZoneHint") }}</p>
      </div>
    </template>
  </div>
</template>
