<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { SchemaDiffCompareOptions, SchemaDiffOptionItem } from "@/types/schemaDiff";

const props = defineProps<{
  options: SchemaDiffCompareOptions;
  optionTree: SchemaDiffOptionItem[];
}>();

const emit = defineEmits<{
  (e: "update:options", options: SchemaDiffCompareOptions): void;
  (e: "close"): void;
}>();

const { t } = useI18n();

// Local copy of options
const localOptions = ref<SchemaDiffCompareOptions>({ ...props.options });

// Watch for external changes
watch(
  () => props.options,
  (newOptions) => {
    localOptions.value = { ...newOptions };
  },
  { deep: true },
);

function isChecked(id: keyof SchemaDiffCompareOptions): boolean {
  return !!localOptions.value[id];
}

function setOption(id: keyof SchemaDiffCompareOptions, checked: boolean) {
  localOptions.value = { ...localOptions.value, [id]: checked };
}

function getChildState(item: SchemaDiffOptionItem): "checked" | "unchecked" | "indeterminate" {
  if (!item.children || item.children.length === 0) {
    return isChecked(item.id) ? "checked" : "unchecked";
  }
  const childStates = item.children.map((child) => getChildState(child));
  if (childStates.every((s) => s === "checked")) return "checked";
  if (childStates.every((s) => s === "unchecked")) return "unchecked";
  return "indeterminate";
}

function toggleItem(item: SchemaDiffOptionItem) {
  const state = getChildState(item);
  const nextChecked = state !== "checked";
  setSubtree(item, nextChecked);
}

function setSubtree(item: SchemaDiffOptionItem, checked: boolean) {
  setOption(item.id, checked);
  if (item.children) {
    for (const child of item.children) {
      setSubtree(child, checked);
    }
  }
}

function handleDone() {
  emit("update:options", { ...localOptions.value });
  emit("close");
}

function handleCancel() {
  emit("close");
}

function getItemClasses(state: "checked" | "unchecked" | "indeterminate"): string {
  const base = "h-4 w-4 rounded border flex items-center justify-center transition-colors cursor-pointer";
  if (state === "checked") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  if (state === "indeterminate") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  return `${base} bg-background border-input hover:border-muted-foreground`;
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex-1 overflow-auto space-y-1">
      <template v-for="item in optionTree" :key="item.id">
        <div class="space-y-1">
          <div class="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer" @click="toggleItem(item)">
            <div :class="getItemClasses(getChildState(item))">
              <svg v-if="getChildState(item) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg v-else-if="getChildState(item) === 'indeterminate'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <span class="text-sm select-none">{{ t(item.labelKey) }}</span>
          </div>
          <div v-if="item.children" class="ml-6 space-y-1">
            <div v-for="child in item.children" :key="child.id" class="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer" @click="toggleItem(child)">
              <div :class="getItemClasses(getChildState(child))">
                <svg v-if="getChildState(child) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span class="text-sm select-none">{{ t(child.labelKey) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div class="flex items-center justify-end gap-2 pt-4 border-t mt-2">
      <Button variant="outline" size="sm" @click="handleCancel">
        {{ t("common.cancel") }}
      </Button>
      <Button size="sm" @click="handleDone">
        {{ t("common.done") }}
      </Button>
    </div>
  </div>
</template>
