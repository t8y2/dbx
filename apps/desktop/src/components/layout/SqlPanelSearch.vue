<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X } from "@lucide/vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SqlFileSearchMode } from "@/lib/sql/sqlFileTreeFilter";

const props = defineProps<{ mode: SqlFileSearchMode; panel: "file" | "library" }>();
const emit = defineEmits<{
  "update:mode": [mode: SqlFileSearchMode];
  query: [query: string];
  pending: [pending: boolean];
}>();
const { t } = useI18n();
// Keep draft keystrokes local: the large parent tree only sees committed queries.
const text = ref("");
const composing = ref(false);
const mode = computed({
  get: () => props.mode,
  set: (value: SqlFileSearchMode) => {
    if (value === props.mode) return;
    // Suspend before the parent changes scope, so its old query cannot start a scan.
    setPending(true);
    emit("update:mode", value);
  },
});
const query = computed(() => text.value.trim().toLowerCase());
const inputAttrs = computed(() => ({ [`data-sql-${props.panel}-search`]: "" }));
const modeAttrs = computed(() => ({ [`data-sql-${props.panel}-search-mode`]: "" }));
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;

function setPending(value: boolean) {
  if (pending === value) return;
  pending = value;
  emit("pending", value);
}
function commit() {
  clearTimeout(timer);
  emit("query", query.value);
  setPending(false);
}
function submit(event: KeyboardEvent) {
  if (!composing.value && !event.isComposing && event.keyCode !== 229) commit();
}
function clear() {
  text.value = "";
  commit();
}
watch(
  [query, () => props.mode, composing],
  () => {
    clearTimeout(timer);
    if (composing.value) {
      setPending(props.mode === "content");
      return;
    }
    if (props.mode === "name" || !query.value) {
      commit();
      return;
    }
    // Invalidate in-flight results once, without rerendering the parent per key.
    setPending(true);
    timer = setTimeout(commit, 500);
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  clearTimeout(timer);
  emit("query", "");
  setPending(false);
});
defineExpose({ text, clear });
</script>

<template>
  <div class="flex items-center gap-1">
    <Select v-model="mode">
      <SelectTrigger v-bind="modeAttrs" class="data-[size=default]:h-6 max-w-[45%] shrink-0 rounded px-1.5 py-0 text-xs" :aria-label="t('sqlFileTree.searchMode')">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="name">{{ t("sqlFileTree.searchByName") }}</SelectItem>
        <SelectItem value="content">{{ t("sqlFileTree.searchByContent") }}</SelectItem>
      </SelectContent>
    </Select>
    <div class="relative min-w-0 flex-1">
      <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
      <input
        v-bind="inputAttrs"
        v-model="text"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="w-full h-6 pl-7 pr-6 text-[13px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        :placeholder="t(mode === 'name' ? 'sqlFileTree.searchPlaceholder' : 'sqlFileTree.searchContentPlaceholder')"
        @keydown.enter="submit"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
      <button v-if="text" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="clear">
        <X class="h-3 w-3" />
      </button>
    </div>
  </div>
</template>
