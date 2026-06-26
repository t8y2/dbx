<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Braces } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import TruncatedTextTooltip from "@/components/ui/TruncatedTextTooltip.vue";
import { loadSqlParameterHistory, rememberSqlParameterValues } from "@/lib/sqlParameterHistory";
import { substituteSqlParameters, type SqlParameterInput, type SqlParameterValueKind } from "@/lib/sqlParameters";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";

const { t } = useI18n();
const { highlight } = useSqlHighlighter();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  sql: string;
  parameters: string[];
}>();

const emit = defineEmits<{
  execute: [sql: string];
}>();

const values = ref<Record<string, SqlParameterInput>>({});
const histories = ref<Record<string, SqlParameterInput[]>>({});
const activeHistoryName = ref("");
let closeHistoryTimer: ReturnType<typeof setTimeout> | undefined;

const parameterKinds: SqlParameterValueKind[] = ["string", "number", "boolean", "null", "raw"];

const resolvedSql = computed(() => substituteSqlParameters(props.sql, values.value));
const highlightedSql = computed(() => highlight(resolvedSql.value));

watch(
  () => [open.value, props.parameters] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    const next: Record<string, SqlParameterInput> = {};
    const nextHistories: Record<string, SqlParameterInput[]> = {};
    for (const name of props.parameters) {
      const history = loadSqlParameterHistory(name);
      nextHistories[name] = history;
      next[name] = values.value[name] ?? history[0] ?? { kind: "string", value: "" };
    }
    values.value = next;
    histories.value = nextHistories;
  },
  { immediate: true },
);

function updateKind(name: string, kind: SqlParameterValueKind) {
  const current = values.value[name] ?? { value: "" };
  const value = kind === "null" ? "NULL" : current.kind === "null" ? "" : current.value;
  values.value[name] = { ...current, kind, value };
}

function updateValue(name: string, value: string) {
  const matchedHistory = histories.value[name]?.find((entry) => entry.value === value);
  values.value[name] = { ...(values.value[name] ?? { kind: "string" }), ...(matchedHistory ? { kind: matchedHistory.kind } : {}), value };
}

function filteredSqlParameterHistory(name: string): SqlParameterInput[] {
  const history = histories.value[name] ?? [];
  const query = values.value[name]?.value?.trim().toLowerCase() ?? "";
  if (!query) return history;
  return history.filter((entry) => entry.value.toLowerCase().includes(query));
}

function focusParameterInput(name: string, event: FocusEvent) {
  if (closeHistoryTimer) clearTimeout(closeHistoryTimer);
  activeHistoryName.value = name;
  const input = event.target as HTMLInputElement;
  void nextTick(() => input.focus());
}

function closeParameterHistory(name: string) {
  closeHistoryTimer = setTimeout(() => {
    if (activeHistoryName.value === name) activeHistoryName.value = "";
  }, 120);
}

function selectHistoryEntry(name: string, entry: SqlParameterInput) {
  if (closeHistoryTimer) clearTimeout(closeHistoryTimer);
  values.value[name] = { ...entry };
  activeHistoryName.value = "";
}

function execute() {
  histories.value = { ...histories.value, ...rememberSqlParameterValues(values.value) };
  open.value = false;
  emit("execute", resolvedSql.value);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[86vh] border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[720px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Braces class="h-5 w-5 text-primary" />
          {{ t("sqlParameters.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid max-h-[calc(86vh-8rem)] gap-4 overflow-y-auto pr-1">
        <p class="text-sm text-muted-foreground">{{ t("sqlParameters.description") }}</p>

        <div class="relative z-20 max-h-[302px] overflow-auto rounded-md border bg-background">
          <div class="min-w-[580px]">
            <div class="sticky top-0 z-10 grid grid-cols-[minmax(140px,1fr)_132px_minmax(180px,1.5fr)] border-b bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
              <div>{{ t("sqlParameters.name") }}</div>
              <div>{{ t("sqlParameters.type") }}</div>
              <div>{{ t("sqlParameters.value") }}</div>
            </div>
            <div v-for="name in parameters" :key="name" class="grid grid-cols-[minmax(140px,1fr)_132px_minmax(180px,1.5fr)] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
              <div class="min-w-0 truncate font-mono text-xs">{{ name }}</div>
              <Select :model-value="values[name]?.kind || 'string'" @update:model-value="(value) => updateKind(name, value as SqlParameterValueKind)">
                <SelectTrigger class="h-8 bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="kind in parameterKinds" :key="kind" :value="kind">
                    {{ t(`sqlParameters.kind.${kind}`) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div class="relative min-w-0">
                <Popover :open="activeHistoryName === name && filteredSqlParameterHistory(name).length > 0">
                  <PopoverAnchor as-child>
                    <Input
                      :model-value="values[name]?.value || ''"
                      class="h-8 bg-background font-mono text-xs"
                      :disabled="values[name]?.kind === 'null'"
                      autocomplete="off"
                      data-lpignore="true"
                      data-form-type="other"
                      :placeholder="t('sqlParameters.valuePlaceholder')"
                      @focus="focusParameterInput(name, $event)"
                      @blur="closeParameterHistory(name)"
                      @update:model-value="(value) => updateValue(name, String(value))"
                    />
                  </PopoverAnchor>
                  <PopoverContent align="start" side="bottom" class="z-[80] w-[var(--reka-popover-trigger-width)] max-h-40 gap-0 overflow-auto p-1" @open-auto-focus.prevent>
                    <button
                      v-for="entry in filteredSqlParameterHistory(name)"
                      :key="`${entry.kind}:${entry.value}`"
                      type="button"
                      class="flex w-full min-w-0 items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                      @mousedown.prevent="selectHistoryEntry(name, entry)"
                    >
                      <TruncatedTextTooltip :text="entry.value" class="min-w-0 flex-1 font-mono" side="top" :delay="150" />
                      <span class="shrink-0 text-[10px] uppercase text-muted-foreground">{{ t(`sqlParameters.kind.${entry.kind}`) }}</span>
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        </div>

        <div class="relative z-10 grid gap-2">
          <div class="text-xs font-medium text-muted-foreground">{{ t("sqlParameters.preview") }}</div>
          <pre class="max-h-48 min-w-0 overflow-auto rounded-md bg-muted px-3 py-3 text-xs font-mono whitespace-pre" v-html="highlightedSql" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button @click="execute">{{ t("sqlParameters.execute") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
