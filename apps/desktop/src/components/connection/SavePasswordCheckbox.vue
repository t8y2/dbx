<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { HelpTooltip } from "@/components/ui/tooltip";

const props = withDefaults(defineProps<{ modelValue?: boolean }>(), { modelValue: true });
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const { t } = useI18n();
</script>

<template>
  <div class="grid grid-cols-4 items-center gap-4">
    <span />
    <div class="col-span-3 flex items-center gap-1.5 text-sm">
      <label class="flex items-center gap-2">
        <input :checked="props.modelValue" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" :aria-label="t('connection.savePassword')" @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
        <span class="whitespace-nowrap">{{ t("connection.savePassword") }}</span>
      </label>
      <HelpTooltip :label="t('connection.savePassword')">
        {{ props.modelValue ? t("connection.savePasswordHint") : t("connection.savePasswordSessionHint") }}
      </HelpTooltip>
    </div>
  </div>
</template>
