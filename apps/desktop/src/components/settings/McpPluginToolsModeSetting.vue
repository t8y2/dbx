<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { McpGlobalPolicy } from "@/stores/settingsStore";

const props = defineProps<{ disabled?: boolean }>();
const mode = defineModel<McpGlobalPolicy["pluginToolsMode"]>({ required: true });
const { t } = useI18n();
const labels = { flat: "settings.mcpPluginToolsModeFlat", lazy: "settings.mcpPluginToolsModeLazy", auto: "settings.mcpPluginToolsModeAuto" };
const description = computed(() => `${labels[mode.value]}Description`);

function updateMode(value: unknown) {
  if (!props.disabled && (value === "flat" || value === "lazy" || value === "auto")) mode.value = value;
}
</script>

<template>
  <details class="rounded-md border p-3" data-mcp-plugin-tools-mode-setting>
    <summary class="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span id="mcp-plugin-tools-mode-label">{{ t("settings.mcpPluginToolsMode") }}</span>
      <span class="ml-2 text-xs font-normal text-muted-foreground" data-mcp-plugin-tools-mode-summary>{{ t(labels[mode]) }}</span>
    </summary>
    <div class="mt-3 space-y-2">
      <p class="text-xs text-muted-foreground">{{ t("settings.mcpPluginToolsModeDescription") }}</p>
      <Select :model-value="mode" :disabled="disabled" @update:model-value="updateMode">
        <SelectTrigger class="h-8 w-full sm:w-56" aria-labelledby="mcp-plugin-tools-mode-label" aria-describedby="mcp-plugin-tools-mode-description" data-mcp-plugin-tools-mode-trigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="flat">{{ t(labels.flat) }}</SelectItem>
          <SelectItem value="lazy">{{ t(labels.lazy) }}</SelectItem>
          <SelectItem value="auto">{{ t(labels.auto) }}</SelectItem>
        </SelectContent>
      </Select>
      <p id="mcp-plugin-tools-mode-description" class="text-xs text-muted-foreground">{{ t(description) }}</p>
    </div>
  </details>
</template>
