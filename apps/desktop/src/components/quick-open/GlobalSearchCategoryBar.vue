<script setup lang="ts">
import { useI18n } from "vue-i18n";

type CategoryDefinition = { id: string; label: string; icon: any };

const props = defineProps<{
  categories: CategoryDefinition[];
  active: string;
  counts: Record<string, number>;
}>();

const emit = defineEmits<{ select: [category: string] }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/20 px-4 py-2">
    <button
      v-for="category in props.categories"
      :key="category.id"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors"
      :class="props.active === category.id ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
      @click="emit('select', category.id)"
    >
      <component :is="category.icon" class="h-3.5 w-3.5" />
      <span>{{ t(category.label) }}</span>
      <span class="rounded-full px-1.5 py-0.5 text-[10px]" :class="props.active === category.id ? 'bg-background/15' : 'bg-muted'">{{ props.counts[category.id] || 0 }}</span>
    </button>
    <div class="ml-auto hidden shrink-0 items-center gap-2 pl-3 text-[11px] text-muted-foreground lg:flex">
      <span><kbd class="rounded bg-muted px-1.5 py-0.5">⌘1–8</kbd> {{ t("quickOpen.switchCategory") }}</span>
      <span><kbd class="rounded bg-muted px-1.5 py-0.5">↵</kbd> {{ t("quickOpen.openAction") }}</span>
    </div>
  </div>
</template>
