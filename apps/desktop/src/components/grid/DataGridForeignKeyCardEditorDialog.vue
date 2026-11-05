<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LayoutTemplate, Loader2, Sparkles } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ForeignKeyCardContent from "./ForeignKeyCardContent.vue";
import * as api from "@/lib/backend/api";
import { isAiConfigModelCandidate } from "@/lib/ai/aiConfigCandidates";
import { runtimeEffortFromPreference } from "@/lib/ai/aiEffortPreference";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { buildForeignKeyCardAiRequest, exampleForeignKeyCardHtml, extractForeignKeyCardHtmlFromAi, FOREIGN_KEY_CARD_TEMPLATE_MAX_LENGTH, fullRecordForeignKeyCardHtml, renderForeignKeyCardHtml } from "@/lib/dataGrid/foreignKeyCard";
import type { ForeignKeyCardRelation } from "@/lib/dataGrid/foreignKeyCardQuery";
import { getAiProviderPreset, normalizeAiConfig, useSettingsStore } from "@/stores/settingsStore";
import type { ColumnInfo } from "@/types/database";

const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{
  table: string;
  columns: readonly ColumnInfo[];
  /** 被引用表自己的外键关联，可用 `{{fk.column}}` 插入。 */
  relations?: readonly ForeignKeyCardRelation[];
  /** 已保存的自定义模板；没有时草稿为空，即以表格显示全部列。 */
  savedHtml?: string;
  previewRecord?: Readonly<Record<string, CellValue | undefined>>;
}>();
const emit = defineEmits<{ save: [html: string]; reset: [] }>();

const { t, locale } = useI18n();
const settingsStore = useSettingsStore();
const draft = ref("");
const instruction = ref("");
const generating = ref(false);
const aiError = ref("");
const editorRef = ref<HTMLTextAreaElement | null>(null);

const PLACEHOLDER_EXAMPLE = "{{column}}";
const RELATED_PLACEHOLDER_EXAMPLE = "{{fk_column.column}}";
const columnNames = computed(() => props.columns.map((column) => column.name));
const previewHtml = computed(() => renderForeignKeyCardHtml(draft.value.trim() ? draft.value : fullRecordForeignKeyCardHtml(columnNames.value), props.previewRecord ?? {}));
const tooLong = computed(() => draft.value.length > FOREIGN_KEY_CARD_TEMPLATE_MAX_LENGTH);

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    draft.value = props.savedHtml?.trim() ? props.savedHtml : "";
    instruction.value = "";
    aiError.value = "";
  },
  { immediate: true },
);

function insertPlaceholder(column: string) {
  const placeholder = `{{${column}}}`;
  const element = editorRef.value;
  if (!element) {
    draft.value += placeholder;
    return;
  }
  const start = element.selectionStart ?? draft.value.length;
  const end = element.selectionEnd ?? start;
  draft.value = draft.value.slice(0, start) + placeholder + draft.value.slice(end);
  void nextTick(() => {
    element.focus();
    element.setSelectionRange(start + placeholder.length, start + placeholder.length);
  });
}

function activeAiConfig() {
  const active = settingsStore.activeModel;
  if (!active) return null;
  const item = settingsStore.aiConfigs.find((config) => config.id === active.configId);
  if (!item || !isAiConfigModelCandidate(item, getAiProviderPreset(item.provider, item.endpoint).requiresApiKey, isTauriRuntime())) return null;
  return normalizeAiConfig({ ...item, model: active.modelId, runtimeEffort: runtimeEffortFromPreference(settingsStore.activeEffort) });
}

async function generateWithAi() {
  aiError.value = "";
  generating.value = true;
  try {
    await settingsStore.initAiConfigs();
    const config = activeAiConfig();
    if (!config) {
      aiError.value = t("grid.foreignKeyCardAiNoModel");
      return;
    }
    // 只发送表名、列名/类型/注释和现有模板，不发送记录值。
    const { systemPrompt, userPrompt } = buildForeignKeyCardAiRequest({
      table: props.table,
      columns: props.columns,
      relations: props.relations,
      instruction: instruction.value,
      currentHtml: draft.value.trim() ? draft.value : undefined,
      language: String(locale.value),
    });
    const answer = await api.aiComplete({ config, systemPrompt, messages: [{ role: "user", content: userPrompt }], maxTokens: 4096 });
    const html = extractForeignKeyCardHtmlFromAi(answer);
    if (!html) {
      aiError.value = t("grid.foreignKeyCardAiEmpty");
      return;
    }
    draft.value = html;
  } catch (error: any) {
    aiError.value = String(error?.message || error);
  } finally {
    generating.value = false;
  }
}

function insertExample() {
  draft.value = exampleForeignKeyCardHtml(columnNames.value);
}

function save() {
  if (tooLong.value) return;
  // 清空后保存 = 删除自定义模板，回到表格显示全部列。
  if (draft.value.trim()) emit("save", draft.value);
  else emit("reset");
  open.value = false;
}

function resetTemplate() {
  emit("reset");
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[960px]" data-foreign-key-card-editor>
      <DialogHeader>
        <DialogTitle>{{ t("grid.foreignKeyCardEditorTitle", { table }) }}</DialogTitle>
        <DialogDescription>{{ t("grid.foreignKeyCardEditorDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_340px]">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex items-center gap-2">
            <input
              v-model="instruction"
              class="h-8 min-w-0 flex-1 rounded-[6px] border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
              :placeholder="t('grid.foreignKeyCardAiPlaceholder')"
              :disabled="generating"
              @keydown.enter.prevent="generateWithAi"
            />
            <Button size="sm" variant="outline" class="h-8" :disabled="generating" @click="generateWithAi">
              <Loader2 v-if="generating" class="mr-1 h-3.5 w-3.5 animate-spin" />
              <Sparkles v-else class="mr-1 h-3.5 w-3.5" />
              {{ t("grid.foreignKeyCardAiGenerate") }}
            </Button>
          </div>
          <p v-if="aiError" class="text-xs text-destructive">{{ aiError }}</p>
          <div class="flex flex-wrap gap-1">
            <button v-for="column in columns" :key="column.name" type="button" class="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" :title="`${column.name} (${column.data_type})`" @click="insertPlaceholder(column.name)">
              {{ column.name }}
            </button>
          </div>
          <div v-for="relation in relations" :key="relation.column" class="flex flex-wrap items-center gap-1">
            <span class="mr-1 text-[11px] text-muted-foreground">{{ t("grid.foreignKeyCardRelatedColumns", { column: relation.column, table: relation.table }) }}</span>
            <button
              v-for="column in relation.columns"
              :key="column.name"
              type="button"
              class="rounded border border-dashed bg-muted/20 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              :title="`${relation.table}.${column.name} (${column.data_type})`"
              @click="insertPlaceholder(`${relation.column}.${column.name}`)"
            >
              {{ relation.column }}.{{ column.name }}
            </button>
          </div>
          <textarea
            ref="editorRef"
            v-model="draft"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            :placeholder="t('grid.foreignKeyCardEditorPlaceholder')"
            class="h-[380px] w-full min-w-0 resize-none rounded-[6px] border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs leading-5 outline-none focus-visible:border-ring"
          />
          <p class="text-xs" :class="tooLong ? 'text-destructive' : 'text-muted-foreground'">{{ t("grid.foreignKeyCardEditorHint", { placeholder: PLACEHOLDER_EXAMPLE, relatedPlaceholder: RELATED_PLACEHOLDER_EXAMPLE }) }}</p>
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <div class="text-xs font-medium text-muted-foreground">{{ t("grid.foreignKeyCardPreview") }}</div>
          <div class="max-h-[460px] overflow-auto rounded-lg border bg-popover p-3 shadow-sm">
            <ForeignKeyCardContent :html="previewHtml" />
          </div>
        </div>
      </div>
      <DialogFooter class="sm:justify-between">
        <div class="flex gap-2">
          <Button variant="ghost" size="sm" @click="insertExample">
            <LayoutTemplate class="mr-1 h-3.5 w-3.5" />
            {{ t("grid.foreignKeyCardInsertExample") }}
          </Button>
          <Button v-if="savedHtml" variant="ghost" size="sm" class="text-destructive" @click="resetTemplate">{{ t("grid.foreignKeyCardDeleteTemplate") }}</Button>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="tooLong" @click="save">{{ t("grid.foreignKeyCardSave") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
