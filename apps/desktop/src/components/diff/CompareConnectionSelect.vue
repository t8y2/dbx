<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import { compareConnectionType } from "@/lib/database/databaseCompareCapabilities";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    connections: ConnectionConfig[];
    layout: SidebarLayout;
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t } = useI18n();
const ALL_TYPES = "all";
const selectedType = ref(ALL_TYPES);
const selectedConnection = computed(() => props.connections.find((connection) => connection.id === props.modelValue));
const typeOptions = computed(() => {
  const options = new Map<string, { value: string; label: string }>();
  for (const connection of props.connections) {
    const type = compareConnectionType(connection);
    if (!options.has(type.value)) options.set(type.value, type);
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
});
const filteredConnections = computed(() => props.connections.filter((connection) => selectedType.value === ALL_TYPES || compareConnectionType(connection).value === selectedType.value));

// Programmatic changes (config restore, prefill, swap) follow the connection.
// Clearing a connection preserves the filter the user just selected.
watch(
  () => selectedConnection.value && compareConnectionType(selectedConnection.value).value,
  (type) => {
    if (type) selectedType.value = type;
  },
  { immediate: true },
);
watch(typeOptions, (options) => {
  if (selectedType.value !== ALL_TYPES && !options.some((option) => option.value === selectedType.value)) selectedType.value = ALL_TYPES;
});

function selectType(value: unknown) {
  if (props.disabled || typeof value !== "string") return;
  selectedType.value = value;
  if (props.modelValue && value !== ALL_TYPES && (!selectedConnection.value || compareConnectionType(selectedConnection.value).value !== value)) {
    emit("update:modelValue", "");
  }
}
</script>

<template>
  <div class="@container min-w-0 space-y-1">
    <div class="grid grid-cols-1 gap-2 @min-[300px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Select :model-value="selectedType" :disabled="disabled || !typeOptions.length" @update:model-value="selectType">
        <SelectTrigger class="h-8 w-full min-w-0 text-xs" :aria-label="t('diff.connType')">
          <SelectValue class="min-w-0 truncate" :placeholder="t('diff.allConnectionTypes')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL_TYPES">{{ t("diff.allConnectionTypes") }}</SelectItem>
          <SelectItem v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
        </SelectContent>
      </Select>
      <ConnectionTreeSelect
        :model-value="selectedConnection ? modelValue : ''"
        :connections="filteredConnections"
        :layout="layout"
        :disabled="disabled || !connections.length"
        :placeholder="t('diff.selectConnection')"
        :search-placeholder="t('diff.searchConnection')"
        :empty-text="t('common.noResults')"
        trigger-class="dbx-diff-connection-trigger h-8 w-full max-w-none justify-between gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-xs shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        list-class="min-w-64 w-[var(--reka-popover-trigger-width)]"
        @update:model-value="(value) => emit('update:modelValue', value)"
      />
    </div>
    <p v-if="modelValue && !selectedConnection" class="text-xs text-muted-foreground">{{ t("diff.unsupportedCompareConnection") }}</p>
  </div>
</template>
