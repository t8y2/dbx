<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

const props = defineProps<{ message: string }>();
const { t } = useI18n();
const expanded = ref(false);
const dismissed = ref(false);
watch(
  () => props.message,
  () => {
    expanded.value = false;
    dismissed.value = false;
  },
  { flush: "sync" },
);

const summary = computed(() => {
  const conflict = props.message.match(/\[TABLE_OR_VIEW_ALREADY_EXISTS\]\s+Cannot create table or view (.+?) because it already exists\./i);
  if (conflict) return t("structureEditor.tableNameConflict", { name: conflict[1] });
  const headline = props.message.trim().split(/\r?\n|\s+at\s+[\w.$]+\(/, 1)[0];
  return headline.length > 220 ? headline.slice(0, 220) + "…" : headline;
});
</script>

<template>
  <div v-if="message && !dismissed" class="min-w-0 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] text-destructive">
    <div class="flex items-center gap-2">
      <p role="alert" class="line-clamp-2 min-w-0 flex-1 break-all">{{ summary }}</p>
      <Button v-if="summary !== message" type="button" variant="ghost" size="sm" class="shrink-0" :aria-expanded="expanded" @click="expanded = !expanded">{{ t("diff.details") }}</Button>
      <Button type="button" variant="ghost" size="sm" class="shrink-0" :aria-label="t('common.close')" :title="t('common.close')" @click="dismissed = true"><X class="size-4" /></Button>
    </div>
    <pre v-if="expanded" tabindex="0" class="mt-1 max-h-[16vh] overflow-auto whitespace-pre-wrap break-all select-text">{{ message }}</pre>
  </div>
</template>
