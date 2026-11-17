<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettingsStore } from "@/stores/settingsStore";
import { aiModelOptions } from "@/lib/ai/aiConfigList";
import { isCliProvider } from "@/lib/ai/aiConfigCandidates";
import { normalizeMcpApprovalAiSettings } from "@/lib/mcp/mcpApprovalSummary";

const props = defineProps<{ disabled?: boolean }>();
const settings = useSettingsStore();
const { t } = useI18n();
const busy = ref(false);
const error = ref(false);
const selection = computed(() => normalizeMcpApprovalAiSettings(settings.editorSettings.mcpApprovalAi));
const options = computed(() => settings.aiConfigs.filter((config) => !isCliProvider(config.provider)).flatMap((config) => aiModelOptions(config, []).map((model) => ({ value: JSON.stringify([config.id, model.id]), label: `${config.name} / ${model.displayName || model.id}` }))));
const value = computed(() => (selection.value.configId ? JSON.stringify([selection.value.configId, selection.value.modelId]) : "__none__"));
onMounted(() => {
  void settings.initAiConfigs().catch(() => {
    error.value = true;
  });
});

async function save(value: string | boolean) {
  if (props.disabled || busy.value) return;
  const next = { ...selection.value };
  if (typeof value === "boolean") next.autoGenerate = value;
  else {
    const [configId, modelId] = value !== "__none__" ? JSON.parse(value) : ["", ""];
    next.configId = configId;
    next.modelId = modelId;
  }
  busy.value = true;
  error.value = false;
  try {
    await settings.updateEditorSettingsAndPersist({ mcpApprovalAi: next });
  } catch {
    error.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-3 border-t pt-3" data-mcp-approval-ai-settings>
    <label class="block space-y-1 text-xs">
      <span class="font-medium">{{ t("settings.mcpApprovalAiModelSelect") }}</span>
      <Select :model-value="value" :disabled="disabled || busy" @update:model-value="save(String($event))">
        <SelectTrigger class="w-full" :aria-label="t('settings.mcpApprovalAiModelSelect')" data-mcp-approval-ai-model><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{{ t("settings.mcpApprovalAiModelNone") }}</SelectItem>
          <SelectItem v-if="value !== '__none__' && !options.some((option) => option.value === value)" :value="value" disabled>{{ t("settings.mcpApprovalAiModelMissing") }}</SelectItem>
          <SelectItem v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
        </SelectContent>
      </Select>
    </label>
    <label class="flex items-center gap-2 text-xs">
      <input type="checkbox" :checked="selection.autoGenerate" :disabled="disabled || busy || !selection.configId" class="shrink-0 accent-primary" data-mcp-approval-ai-auto @change="save(($event.target as HTMLInputElement).checked)" />
      {{ t("settings.mcpApprovalAiAuto") }}
    </label>
    <p class="text-xs text-muted-foreground">{{ t("settings.mcpApprovalAiSettingsHint") }}</p>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ t("settings.mcpApprovalAiSaveFailed") }}</p>
  </div>
</template>
