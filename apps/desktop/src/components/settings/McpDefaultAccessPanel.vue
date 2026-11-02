<script setup lang="ts">
import { computed, nextTick, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Check, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { MCP_CAPABILITY_ROWS, MCP_EXECUTION_MODE_COLUMNS, type McpExecutionMode } from "@/lib/mcp/mcpPolicySelection";

const props = defineProps<{ mode: McpExecutionMode; disabled?: boolean }>();
const emit = defineEmits<{ "set:mode": [mode: McpExecutionMode] }>();
const { t } = useI18n();
const labelId = useId();
const descriptionId = useId();
const descriptionKey = computed(() => `${MCP_EXECUTION_MODE_COLUMNS.find((column) => column.mode === props.mode)!.labelKey}Description`);

function selectMode(mode: McpExecutionMode) {
  if (!props.disabled && mode !== props.mode) emit("set:mode", mode);
}

async function onModeKeydown(event: KeyboardEvent, mode: McpExecutionMode) {
  if (props.disabled) return;
  const modes = MCP_EXECUTION_MODE_COLUMNS.map((column) => column.mode);
  const current = modes.indexOf(mode);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = modes.length - 1;
  else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % modes.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + modes.length) % modes.length;
  else return;
  event.preventDefault();
  event.stopPropagation();
  const group = (event.currentTarget as HTMLElement).closest('[role="radiogroup"]');
  selectMode(modes[next]);
  await nextTick();
  // The parent can reject full access in its confirmation dialog.
  group?.querySelector<HTMLElement>(`[data-mcp-execution-mode="${props.mode}"]`)?.focus();
}
</script>

<template>
  <section class="min-w-0 space-y-3 rounded-md border bg-background p-3 sm:p-4" data-mcp-default-access>
    <header class="space-y-1">
      <h3 :id="labelId" class="text-sm font-semibold">{{ t("settings.mcpExecutionMode") }}</h3>
      <p class="text-xs text-muted-foreground">{{ t("settings.mcpExecutionModeDescription") }}</p>
    </header>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" :aria-labelledby="labelId" :aria-describedby="descriptionId">
      <Button
        v-for="column in MCP_EXECUTION_MODE_COLUMNS"
        :key="column.mode"
        type="button"
        role="radio"
        variant="outline"
        class="settings-choice-card h-auto min-h-10 whitespace-normal px-3 py-2 text-center"
        :class="mode === column.mode ? 'dbx-choice-selected' : ''"
        :disabled="disabled"
        :data-mcp-execution-mode="column.mode"
        :aria-checked="mode === column.mode"
        :tabindex="mode === column.mode ? 0 : -1"
        @click="selectMode(column.mode)"
        @keydown="onModeKeydown($event, column.mode)"
        >{{ t(column.labelKey) }}</Button
      >
    </div>
    <p :id="descriptionId" class="text-xs leading-relaxed text-muted-foreground" data-mcp-mode-description>{{ t(descriptionKey) }}</p>
    <details class="space-y-2 border-t border-border/60 pt-3" data-mcp-permission-help>
      <summary class="cursor-pointer rounded-sm text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ t("settings.mcpCapabilityTitle") }}</summary>
      <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t("settings.mcpCapabilityDescription") }}</p>
      <div class="overflow-x-auto rounded border bg-background">
        <table class="w-full min-w-[34rem] table-fixed text-xs">
          <thead class="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" class="w-[46%] px-3 py-2 text-left font-medium">{{ t("settings.mcpCapabilityOperation") }}</th>
              <th v-for="column in MCP_EXECUTION_MODE_COLUMNS" :key="column.mode" scope="col" class="px-2 py-2 text-center font-medium">{{ t(column.labelKey) }}</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="row in MCP_CAPABILITY_ROWS" :key="row.labelKey">
              <th scope="row" class="px-3 py-2 text-left font-normal leading-relaxed">{{ t(row.labelKey) }}</th>
              <td v-for="column in MCP_EXECUTION_MODE_COLUMNS" :key="column.mode" class="px-2 py-2 text-center">
                <span class="inline-flex items-center justify-center" :class="row[column.mode] ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/60'">
                  <Check v-if="row[column.mode]" class="h-4 w-4" aria-hidden="true" />
                  <X v-else class="h-4 w-4" aria-hidden="true" />
                  <span class="sr-only">{{ t(row[column.mode] ? "settings.mcpCapabilityAllowed" : "settings.mcpCapabilityBlocked") }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t("settings.mcpCapabilityAlwaysEnforced") }}</p>
    </details>
  </section>
</template>
