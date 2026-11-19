<script setup lang="ts">
import { useId } from "vue";
import { useI18n } from "vue-i18n";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";

const { t } = useI18n();
const id = useId();
const mode = defineModel<ManualExportMode>({ default: "immediate" });
</script>

<template>
  <fieldset class="space-y-2">
    <legend class="text-sm font-medium">{{ t("exportProgress.executionMode") }}</legend>
    <div class="flex flex-wrap gap-x-5 gap-y-2">
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input v-model="mode" type="radio" :name="id" value="immediate" class="h-4 w-4" />
        {{ t("exportProgress.immediate") }}
      </label>
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input v-model="mode" type="radio" :name="id" value="queued" class="h-4 w-4" />
        {{ t("exportProgress.queue") }}
      </label>
    </div>
    <p class="text-xs text-muted-foreground">{{ t("exportProgress.executionModeHint") }}</p>
  </fieldset>
</template>
