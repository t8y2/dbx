<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "@lucide/vue";
import type { TreeNode } from "@/types/database";
import { MODEL_RENDERERS, generateModel, modelRenderer, type ModelFormatId } from "@/lib/model/modelRendererRegistry";
import { renderModelTemplate, type ModelTemplate } from "@/lib/model/modelTemplates";
import { pascalCase } from "@/lib/model/modelShape";
import { useModelGenerationRuntime } from "@/composables/useModelGenerationRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { promptExportSavePath } from "@/lib/export/exportPath";
import { translateBackendError } from "@/i18n/backend-errors";
import { uuid } from "@/lib/common/utils";
import { useTheme } from "@/composables/useTheme";
import { createModelCodeHighlighter } from "@/lib/model/modelCodeHighlighter";

const props = defineProps<{ target: TreeNode }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const { isDark } = useTheme();
const settings = useSettingsStore();
const { toast } = useToast();
const { shape, loading, error, load } = useModelGenerationRuntime();
const selected = ref("typescript");
const search = ref("");
const showHeaderComments = ref(false);
const editing = ref(false);
const saving = ref(false);
const draft = ref<ModelTemplate>({ id: "", name: "", extension: "txt", body: "{{table.name}}\n{{#columns}}{{column.name}}: {{column.type}}\n{{/columns}}" });
watch(
  () => props.target,
  (target) => void load({ ...target }),
  { immediate: true },
);
const templates = computed(() => settings.editorSettings.modelGenerationTemplates ?? []);
const custom = computed(() => templates.value.find((item) => item.id === selected.value));
const priority = ["rust-struct", "go-struct", "java", "typescript", "pydantic", "python-dataclass", "php"];
const orderedRenderers = computed(() =>
  [...MODEL_RENDERERS].sort((a, b) => {
    const ai = priority.indexOf(a.id);
    const bi = priority.indexOf(b.id);
    return (ai === -1 ? priority.length : ai) - (bi === -1 ? priority.length : bi);
  }),
);
const searchTerm = computed(() => search.value.trim().toLowerCase());
const filteredRenderers = computed(() => orderedRenderers.value.filter((format) => !searchTerm.value || format.label.toLowerCase().includes(searchTerm.value)));
const filteredTemplates = computed(() => templates.value.filter((item) => !searchTerm.value || item.name.toLowerCase().includes(searchTerm.value)));
const selectedLabel = computed(() => custom.value?.name ?? modelRenderer(selected.value as ModelFormatId)?.label ?? selected.value);
const highlightedCode = ref("");
let highlightRequest = 0;
const rendered = computed(() => {
  if (!shape.value) return { code: "", error: "" };
  try {
    const code = editing.value ? renderModelTemplate(draft.value.body, shape.value) : custom.value ? renderModelTemplate(custom.value.body, shape.value) : generateModel(shape.value, selected.value as ModelFormatId, { includeHeaderComments: showHeaderComments.value });
    return { code, error: "" };
  } catch (reason) {
    return { code: "", error: String(reason) };
  }
});
watch(
  [() => rendered.value.code, () => selected.value, () => isDark.value],
  async ([code, format, dark]) => {
    const request = ++highlightRequest;
    if (!code) {
      highlightedCode.value = "";
      return;
    }
    try {
      const highlighter = await createModelCodeHighlighter({ appearance: () => (isDark.value ? "dark" : "light") });
      if (request === highlightRequest) highlightedCode.value = highlighter(code, format as ModelFormatId, dark ? "dark" : "light");
    } catch {
      if (request === highlightRequest) highlightedCode.value = "";
    }
  },
  { immediate: true },
);
const extension = computed(() => (editing.value ? draft.value.extension : (custom.value?.extension ?? modelRenderer(selected.value as ModelFormatId)?.extension ?? "txt")));
const fileName = computed(() => `${pascalCase(props.target.label)}.${extension.value}`);
function editTemplate() {
  draft.value = custom.value ? { ...custom.value } : { id: uuid(), name: "", extension: "txt", body: "{{table.name}}\n{{#columns}}{{column.name}}: {{column.type}}\n{{/columns}}" };
  editing.value = true;
}
async function saveTemplate(remove = false) {
  saving.value = true;
  try {
    const id = remove ? custom.value?.id : draft.value.id;
    const next = templates.value.filter((item) => item.id !== id);
    if (!remove) next.push({ ...draft.value, name: draft.value.name.trim() });
    await settings.updateEditorSettingsAndPersist({ modelGenerationTemplates: next });
    selected.value = remove ? "typescript" : draft.value.id;
    editing.value = false;
  } catch (reason) {
    toast(String(reason), 5000);
  } finally {
    saving.value = false;
  }
}
async function copy() {
  try {
    await copyToClipboard(rendered.value.code);
    toast(t("connection.copied"));
  } catch (reason) {
    toast(t("grid.copyFailed", { message: String(reason) }), 5000);
  }
}
async function save() {
  const code = rendered.value.code;
  const name = fileName.value;
  const ext = extension.value;
  saving.value = true;
  try {
    if (isTauriRuntime()) {
      const path = await promptExportSavePath({ defaultFileName: name, filters: [{ name: ext, extensions: [ext] }], preferredPath: settings.editorSettings.preferredExportPath });
      if (!path) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, code);
    } else {
      const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast(t("grid.exported"));
  } catch (reason) {
    toast(t("grid.exportFailed", { message: String(reason) }), 5000);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog
    :open="true"
    @update:open="
      (open) => {
        if (!open) emit('close');
      }
    "
  >
    <DialogContent class="flex h-[min(780px,90vh)] max-w-[min(1180px,95vw)] flex-col gap-0 overflow-hidden p-0">
      <DialogHeader class="shrink-0 border-b px-6 py-4">
        <DialogTitle>{{ t("modelGeneration.title") }} · {{ target.label }}</DialogTitle>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside class="flex w-full shrink-0 flex-col border-b bg-muted/20 md:w-64 md:border-b-0 md:border-r">
          <div class="border-b p-3">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input v-model="search" class="pl-8" :placeholder="t('modelGeneration.search')" :aria-label="t('modelGeneration.search')" />
            </div>
          </div>
          <nav class="min-h-0 flex-1 overflow-y-auto p-2" :aria-label="t('modelGeneration.targets')">
            <div class="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t("modelGeneration.languages") }}</div>
            <button
              v-for="format in filteredRenderers"
              :key="format.id"
              type="button"
              class="mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              :class="selected === format.id && !editing ? 'bg-primary/10 font-medium text-primary' : 'text-foreground'"
              :aria-current="selected === format.id && !editing ? 'true' : undefined"
              @click="
                selected = format.id;
                editing = false;
              "
            >
              <span class="truncate">{{ format.label }}</span>
            </button>
            <div v-if="filteredTemplates.length" class="mb-1 mt-4 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t("modelGeneration.customTemplates") }}</div>
            <button
              v-for="item in filteredTemplates"
              :key="item.id"
              type="button"
              class="mb-1 flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              :class="selected === item.id && !editing ? 'bg-primary/10 font-medium text-primary' : 'text-foreground'"
              :aria-current="selected === item.id && !editing ? 'true' : undefined"
              @click="
                selected = item.id;
                editing = false;
              "
            >
              <span class="truncate">{{ item.name }}</span>
            </button>
            <p v-if="!filteredRenderers.length && !filteredTemplates.length" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t("modelGeneration.noMatches") }}</p>
          </nav>
          <div class="flex shrink-0 flex-wrap gap-2 border-t p-3">
            <Button size="sm" variant="outline" @click="editTemplate">{{ t(custom ? "modelGeneration.editTemplate" : "modelGeneration.addTemplate") }}</Button>
            <Button v-if="custom && !editing" size="sm" variant="outline" :disabled="saving" @click="saveTemplate(true)">{{ t("modelGeneration.deleteTemplate") }}</Button>
            <Button size="sm" variant="outline" :disabled="loading" @click="load({ ...target })">{{ t("contextMenu.refreshChildren") }}</Button>
          </div>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col p-4 md:p-5">
          <div class="mb-3 flex shrink-0 items-center justify-between gap-3">
            <div>
              <p class="text-xs text-muted-foreground">{{ t("modelGeneration.outputFormat") }}</p>
              <h2 class="text-lg font-semibold">{{ editing ? t("modelGeneration.editTemplate") : selectedLabel }}</h2>
            </div>
            <label v-if="!editing && !custom" class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <input v-model="showHeaderComments" type="checkbox" class="size-3.5 accent-primary" :aria-label="t('modelGeneration.showHeaderComments')" />
              {{ t("modelGeneration.showHeaderComments") }}
            </label>
          </div>

          <div v-if="editing" class="mb-3 grid shrink-0 gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
            <label class="text-sm">{{ t("modelGeneration.templateName") }}<Input v-model="draft.name" class="mt-1" /></label>
            <label class="text-sm">{{ t("modelGeneration.extension") }}<Input v-model="draft.extension" class="mt-1" /></label>
            <p class="text-xs text-muted-foreground sm:col-span-2">{{ t("modelGeneration.templateHelp") }}</p>
            <textarea v-model="draft.body" :aria-label="t('modelGeneration.templateBody')" spellcheck="false" class="h-28 rounded border bg-background p-3 font-mono text-xs sm:col-span-2" />
            <Button class="sm:col-span-2 sm:w-fit" :disabled="saving || !draft.name.trim() || !/^[a-zA-Z0-9]+$/.test(draft.extension) || !!rendered.error" @click="saveTemplate()">{{ t("common.save") }}</Button>
          </div>

          <p v-if="loading" class="py-6 text-sm text-muted-foreground">{{ t("contextMenu.exportStructureLoading") }}</p>
          <p v-else-if="error" class="py-6 text-sm text-destructive">{{ translateBackendError(t, error) }}</p>
          <p v-else-if="rendered.error" class="py-6 text-sm text-destructive">{{ rendered.error }}</p>
          <template v-else>
            <p v-if="shape?.columns.some((column) => column.normalizedType === 'unknown')" class="mb-2 shrink-0 text-xs text-muted-foreground">{{ t("modelGeneration.unknownTypes") }}</p>
            <div v-if="highlightedCode" :aria-label="t('modelGeneration.preview')" class="model-code-preview min-h-0 w-full flex-1 overflow-auto rounded-lg border bg-muted/30 text-xs leading-5" v-html="highlightedCode" />
            <pre v-else :aria-label="t('modelGeneration.preview')" class="min-h-0 w-full flex-1 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-5 whitespace-pre-wrap">{{ rendered.code }}</pre>
          </template>

          <div class="mt-3 flex shrink-0 justify-end gap-2">
            <Button variant="outline" :disabled="loading || !rendered.code" @click="copy">{{ t("modelGeneration.copy") }}</Button>
            <Button :disabled="loading || saving || !rendered.code || !/^[a-zA-Z0-9]+$/.test(extension)" @click="save">{{ t("modelGeneration.save") }} · {{ fileName }}</Button>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.model-code-preview :deep(pre) {
  min-height: 100%;
  margin: 0;
  overflow: visible;
  padding: 1rem;
  background: transparent !important;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 0.75rem;
  line-height: 1.55;
  tab-size: 4;
  white-space: pre;
}

.model-code-preview :deep(code) {
  display: block;
  min-width: max-content;
}

.model-code-preview :deep(.line) {
  display: block;
  white-space: pre;
}

.model-code-preview :deep(.line:empty) {
  min-height: 1.55em;
}

.model-code-preview {
  padding: 1rem;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 0.75rem;
  line-height: 1.55;
  tab-size: 4;
  white-space: pre;
}
</style>
