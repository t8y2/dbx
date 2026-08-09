<script setup lang="ts">
import { computed } from "vue";
import type { Translate } from "../docsWarnings";
import { groupStyle } from "../groupColor";
import type { GroupAnnotation } from "../types";

const props = defineProps<{
  groups: GroupAnnotation[];
  /** Id of the selected group, or null when the table belongs to none. */
  modelValue: string | null;
  translate: Translate;
}>();

const emit = defineEmits<{
  "update:modelValue": [groupId: string | null];
  create: [];
}>();

/**
 * Value of the "New group…" option. Group ids come from a hand-editable notes
 * file, so this is treated as the sentinel only when no real group claims it —
 * otherwise picking that group would silently open a create flow instead.
 */
const CREATE = "__dbx_new_group__";

const selected = computed(() => props.groups.find((group) => group.id === props.modelValue) ?? null);

function choose(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (select.value === CREATE && !props.groups.some((group) => group.id === CREATE)) {
    // "New group…" is an action, not a selection: park the select back on the
    // current group so it does not display a group that does not exist.
    select.value = props.modelValue ?? "";
    emit("create");
    return;
  }
  emit("update:modelValue", select.value === "" ? null : select.value);
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <span v-if="selected" class="docs-group h-3 w-3 shrink-0 rounded-full" style="background-color: var(--group-c)" :style="groupStyle(selected.hue)"></span>
    <select :value="modelValue ?? ''" class="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-ring" @change="choose($event)">
      <option value="">{{ translate("docs.noGroup") }}</option>
      <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
      <option :value="CREATE">{{ translate("docs.newGroup") }}</option>
    </select>
  </div>
</template>
