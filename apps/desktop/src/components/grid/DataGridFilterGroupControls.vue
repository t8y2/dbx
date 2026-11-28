<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Eye, EyeOff, Plus, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

defineProps<{
  groupNumbers: number[];
  activeGroup: number;
  hasRules: boolean;
  allDisabled: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  addGroup: [];
  selectGroup: [groupNumber: number];
  deleteGroup: [];
  toggleAll: [];
}>();
const { t } = useI18n();
</script>

<template>
  <div data-filter-group-controls class="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1">
    <Select :model-value="String(activeGroup)" :disabled="disabled || groupNumbers.length < 2" @update:model-value="emit('selectGroup', Number($event))">
      <SelectTrigger size="sm" class="h-7 min-w-24 gap-2 text-xs" :aria-label="t('grid.filterGroup')">
        <SelectValue>{{ t("grid.filterGroupNumber", { number: activeGroup }) }}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="groupNumber in groupNumbers" :key="groupNumber" :value="String(groupNumber)">{{ t("grid.filterGroupNumber", { number: groupNumber }) }}</SelectItem>
      </SelectContent>
    </Select>
    <Button type="button" size="icon" variant="ghost" class="h-7 w-7" :disabled="disabled" :aria-label="t('grid.addFilterGroup')" :title="t('grid.addFilterGroup')" @click="emit('addGroup')"><Plus class="h-3.5 w-3.5" /></Button>
    <Button v-if="groupNumbers.length > 1" type="button" size="icon" variant="ghost" class="h-7 w-7" :disabled="disabled" :aria-label="t('grid.deleteFilterGroup')" :title="t('grid.deleteFilterGroup')" @click="emit('deleteGroup')"><Trash2 class="h-3.5 w-3.5" /></Button>
    <Button type="button" size="sm" variant="ghost" class="h-7 gap-1.5 px-2 text-xs" :disabled="disabled || !hasRules" @click="emit('toggleAll')">
      <Eye v-if="allDisabled" class="h-3.5 w-3.5" />
      <EyeOff v-else class="h-3.5 w-3.5" />
      {{ t(allDisabled ? "grid.enableAllFilterRules" : "grid.disableAllFilterRules") }}
    </Button>
  </div>
</template>
