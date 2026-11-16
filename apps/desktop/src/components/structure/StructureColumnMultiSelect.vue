<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
const props = defineProps<{ modelValue: string[]; columns: Array<{ id: string; name: string }>; label: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const { t } = useI18n();
const missing = computed(() => props.modelValue.filter((id) => !props.columns.some((column) => column.id === id)));
const names = computed(() => props.modelValue.map((id) => props.columns.find((column) => column.id === id)?.name ?? t("starrocksLayout.unavailableColumn")).join(", "));
function setChecked(id: string, checked: boolean) {
  emit("update:modelValue", checked ? [...props.modelValue.filter((value) => value !== id), id] : props.modelValue.filter((value) => value !== id));
}
</script>
<template>
  <div class="space-y-1">
    <span class="block text-muted-foreground">{{ label }}</span>
    <DropdownMenu>
      <DropdownMenuTrigger as-child
        ><Button variant="outline" size="sm" class="h-8 w-52 justify-between font-normal" :disabled="disabled" :aria-label="label"
          ><span class="truncate">{{ names || t("starrocksLayout.selectColumn") }}</span
          ><ChevronDown class="size-3.5 shrink-0" /></Button
      ></DropdownMenuTrigger>
      <DropdownMenuContent class="max-h-56 min-w-52 overflow-y-auto">
        <DropdownMenuCheckboxItem v-for="column in columns" :key="column.id" :model-value="modelValue.includes(column.id)" @select.prevent @update:model-value="setChecked(column.id, $event)">{{ column.name }}</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem v-for="id in missing" :key="id" :model-value="true" @select.prevent @update:model-value="setChecked(id, $event)">{{ t("starrocksLayout.unavailableColumn") }}</DropdownMenuCheckboxItem>
        <div v-if="columns.length === 0 && missing.length === 0" class="px-2 py-1 text-xs text-muted-foreground">{{ t("starrocksLayout.noEligibleColumns") }}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
