<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RoutineParameter } from "@/lib/table/routineExecutionSql";

defineProps<{
  parameters: RoutineParameter[];
  returnType?: string;
}>();

const { t } = useI18n();

function defaultLabel(parameter: RoutineParameter): string {
  if (!parameter.hasDefault) return "-";
  return parameter.defaultValue?.trim() || "DEFAULT";
}
</script>

<template>
  <div class="max-h-52 shrink-0 overflow-auto rounded border bg-background" data-routine-metadata>
    <div v-if="returnType" class="flex items-center gap-3 border-b bg-muted/50 px-3 py-2 text-xs" data-routine-return-type>
      <span class="font-semibold text-muted-foreground">RETURN</span>
      <span class="font-mono">{{ returnType }}</span>
    </div>
    <div v-if="parameters.length" class="min-w-[620px]">
      <div class="grid grid-cols-[minmax(140px,1.2fr)_minmax(150px,1.3fr)_80px_minmax(150px,1.3fr)] border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>{{ t("contextMenu.parameterName") }}</div>
        <div>{{ t("contextMenu.parameterType") }}</div>
        <div>{{ t("contextMenu.parameterMode") }}</div>
        <div>{{ t("contextMenu.parameterDefault") }}</div>
      </div>
      <div v-for="parameter in parameters" :key="`${parameter.ordinal}:${parameter.name}`" class="grid grid-cols-[minmax(140px,1.2fr)_minmax(150px,1.3fr)_80px_minmax(150px,1.3fr)] gap-2 border-b px-3 py-2 text-xs last:border-b-0" data-routine-parameter>
        <div class="truncate font-medium" :title="parameter.name">{{ parameter.name }}</div>
        <div class="truncate font-mono text-muted-foreground" :title="parameter.dataType">{{ parameter.dataType }}</div>
        <div class="text-muted-foreground">{{ parameter.mode }}</div>
        <div class="truncate font-mono text-muted-foreground" :title="defaultLabel(parameter)">
          {{ defaultLabel(parameter) }}
        </div>
      </div>
    </div>
  </div>
</template>
