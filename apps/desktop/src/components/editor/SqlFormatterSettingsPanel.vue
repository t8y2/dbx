<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Upload, Download, RotateCcw, WandSparkles, Save, Copy } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/clipboard";
import {
  DEFAULT_SQL_FORMATTER_SETTINGS,
  SQL_FORMATTER_CONFIG_FORMATTER,
  SQL_FORMATTER_CONFIG_VERSION,
  normalizeSqlFormatterSettings,
  parseSqlFormatterConfig,
  serializeSqlFormatterConfig,
  syncSqlFormatterConfigDraft,
  type SqlFormatterCase,
  type SqlFormatterExpressionWidth,
  type SqlFormatterIndentStyle,
  type SqlFormatterLinesBetweenQueries,
  type SqlFormatterLogicalOperatorNewline,
  type SqlFormatterOptionSettings,
  type SqlFormatterParamTypes,
  type SqlFormatterSettings,
  type SqlFormatterTabWidth,
} from "@/lib/sqlFormatterConfig";

type EditorViewInstance = import("@codemirror/view").EditorView;
type CodeMirrorModules = {
  view: typeof import("@codemirror/view");
  state: typeof import("@codemirror/state");
  langJson: typeof import("@codemirror/lang-json");
  commands: typeof import("@codemirror/commands");
  search: typeof import("@codemirror/search");
};

const props = defineProps<{
  modelValue: SqlFormatterSettings;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: SqlFormatterSettings];
  validityChange: [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();

const activeMode = ref<"form" | "json">("form");
const fileInputRef = ref<HTMLInputElement>();
const jsonEditorRef = ref<HTMLDivElement>();
const jsonDraft = ref(serializeSqlFormatterConfig(props.modelValue));
const jsonValidationMessage = ref("");
const importError = ref("");
const advancedConfigError = ref("");
const jsonEditorLoading = ref(false);
const jsonEditorReady = ref(false);
const jsonEditorLoadError = ref("");
const paramTypesDraft = ref("");
const focusedAdvancedOption = ref<"paramTypes" | null>(null);

let cmView: EditorViewInstance | null = null;
let cmModules: CodeMirrorModules | null = null;
let lastValidity: boolean | null = null;

const settings = computed(() => normalizeSqlFormatterSettings(props.modelValue));

const caseOptions: { value: SqlFormatterCase; labelKey: string }[] = [
  { value: "upper", labelKey: "settings.sqlFormatterCaseUpper" },
  { value: "lower", labelKey: "settings.sqlFormatterCaseLower" },
  { value: "preserve", labelKey: "settings.sqlFormatterCasePreserve" },
];

const logicalOperatorOptions: { value: SqlFormatterLogicalOperatorNewline; labelKey: string }[] = [
  { value: "before", labelKey: "settings.sqlFormatterLogicalBefore" },
  { value: "after", labelKey: "settings.sqlFormatterLogicalAfter" },
];

const indentStyleOptions: { value: SqlFormatterIndentStyle; labelKey: string }[] = [
  { value: "standard", labelKey: "settings.sqlFormatterIndentStyleStandard" },
  { value: "tabularLeft", labelKey: "settings.sqlFormatterIndentStyleTabularLeft" },
  { value: "tabularRight", labelKey: "settings.sqlFormatterIndentStyleTabularRight" },
];

const tabWidthOptions: SqlFormatterTabWidth[] = [2, 4];
const expressionWidthOptions: SqlFormatterExpressionWidth[] = [50, 80, 120];
const linesBetweenQueriesOptions: SqlFormatterLinesBetweenQueries[] = [0, 1, 2];
const sqlFormatterOptionLabelKeys: Record<keyof SqlFormatterOptionSettings, string> = {
  keywordCase: "settings.sqlFormatterKeywordCase",
  dataTypeCase: "settings.sqlFormatterDataTypeCase",
  functionCase: "settings.sqlFormatterFunctionCase",
  identifierCase: "settings.sqlFormatterIdentifierCase",
  indentStyle: "settings.sqlFormatterIndentStyle",
  useTabs: "settings.sqlFormatterIndent",
  tabWidth: "settings.sqlFormatterTabWidth",
  logicalOperatorNewline: "settings.sqlFormatterLogicalOperatorNewline",
  expressionWidth: "settings.sqlFormatterExpressionWidth",
  linesBetweenQueries: "settings.sqlFormatterLinesBetweenQueries",
  denseOperators: "settings.sqlFormatterDenseOperators",
  newlineBeforeSemicolon: "settings.sqlFormatterNewlineBeforeSemicolon",
  paramTypes: "settings.sqlFormatterParamTypes",
};
const sqlFormatterConfigErrorKeys: Record<string, string> = {
  "Invalid JSON.": "settings.sqlFormatterConfigErrorInvalidJson",
  "Config must be a JSON object.": "settings.sqlFormatterConfigErrorObject",
  "Unsupported config version.": "settings.sqlFormatterConfigErrorVersion",
  "Unsupported formatter.": "settings.sqlFormatterConfigErrorFormatter",
  "Unsupported formatter option: params.": "settings.sqlFormatterConfigErrorUnsupportedParams",
  "Config options must be a JSON object.": "settings.sqlFormatterConfigErrorOptionsObject",
};

function emitValidity(value: boolean) {
  if (lastValidity === value) return;
  lastValidity = value;
  emit("validityChange", value);
}

function setJsonDraftText(text: string) {
  jsonDraft.value = text;
  if (!cmView || cmView.state.doc.toString() === text) return;
  cmView.dispatch({
    changes: { from: 0, to: cmView.state.doc.length, insert: text },
  });
}

function localizeSqlFormatterConfigError(message: string): string {
  const exactKey = sqlFormatterConfigErrorKeys[message];
  if (exactKey) return t(exactKey);

  const unknownOption = message.match(/^Unknown formatter option: (.+)\.$/);
  if (unknownOption?.[1]) {
    return t("settings.sqlFormatterConfigErrorUnknownOption", { option: unknownOption[1] });
  }

  const invalidOption = message.match(/^Invalid formatter option value: (.+)\.$/);
  if (invalidOption?.[1]) {
    const labelKey = sqlFormatterOptionLabelKeys[invalidOption[1] as keyof SqlFormatterOptionSettings];
    if (labelKey) {
      return t("settings.sqlFormatterConfigErrorInvalidOptionValue", { option: t(labelKey) });
    }
  }

  return t("settings.sqlFormatterConfigErrorInvalidConfig");
}

function validateJsonDraft(text = jsonDraft.value): boolean {
  const result = parseSqlFormatterConfig(text);
  jsonValidationMessage.value = result.ok ? "" : localizeSqlFormatterConfigError(result.message);
  const valid = result.ok;
  emitValidity(activeMode.value === "json" ? valid : true);
  return valid;
}

function syncJsonDraft(text = jsonDraft.value): boolean {
  const result = syncSqlFormatterConfigDraft(text, updateSettings);
  jsonValidationMessage.value = result.ok ? "" : localizeSqlFormatterConfigError(result.message);
  emitValidity(activeMode.value === "json" ? result.ok : true);
  return result.ok;
}

function updateSettings(next: unknown) {
  importError.value = "";
  advancedConfigError.value = "";
  emit("update:modelValue", normalizeSqlFormatterSettings(next));
}

function updateOption<K extends keyof SqlFormatterSettings>(key: K, value: SqlFormatterSettings[K]) {
  updateSettings({ ...settings.value, [key]: value });
}

function onCaseOption(key: "keywordCase" | "functionCase" | "dataTypeCase", value: any) {
  if (value === "upper" || value === "lower" || value === "preserve") updateOption(key, value);
}

function onIdentifierCase(value: any) {
  if (value === "upper" || value === "lower" || value === "preserve") updateOption("identifierCase", value);
}

function onIndentStyle(value: any) {
  if (value === "standard" || value === "tabularLeft" || value === "tabularRight") updateOption("indentStyle", value);
}

function onLogicalOperatorNewline(value: any) {
  if (value === "before" || value === "after") updateOption("logicalOperatorNewline", value);
}

function onTabWidth(value: any) {
  const next = Number(value);
  if (next === 2 || next === 4) updateOption("tabWidth", next);
}

function onExpressionWidth(value: any) {
  const next = Number(value);
  if (next === 50 || next === 80 || next === 120) updateOption("expressionWidth", next);
}

function onLinesBetweenQueries(value: any) {
  const next = Number(value);
  if (next === 0 || next === 1 || next === 2) updateOption("linesBetweenQueries", next);
}

function restoreDefaults() {
  updateSettings(DEFAULT_SQL_FORMATTER_SETTINGS);
}

function stringifyAdvancedOption(value: SqlFormatterParamTypes | null): string {
  return JSON.stringify(value, null, 2);
}

function setAdvancedDraft(value: SqlFormatterParamTypes | null) {
  paramTypesDraft.value = stringifyAdvancedOption(value);
}

function onAdvancedJsonInput(event: Event) {
  paramTypesDraft.value = (event.target as HTMLTextAreaElement).value;
}

function onJsonDraftTextareaInput(event: Event) {
  const text = (event.target as HTMLTextAreaElement).value;
  jsonDraft.value = text;
  syncJsonDraft(text);
}

function onAdvancedJsonFocus() {
  focusedAdvancedOption.value = "paramTypes";
}

function onAdvancedJsonBlur() {
  focusedAdvancedOption.value = null;
  applyAdvancedJsonOption();
}

function applyAdvancedJsonOption() {
  let parsed: unknown = null;
  const draft = paramTypesDraft.value.trim();
  if (draft) {
    try {
      parsed = JSON.parse(draft);
    } catch {
      advancedConfigError.value = localizeSqlFormatterConfigError("Invalid JSON.");
      return;
    }
  }

  const result = parseSqlFormatterConfig(
    JSON.stringify({
      version: SQL_FORMATTER_CONFIG_VERSION,
      formatter: SQL_FORMATTER_CONFIG_FORMATTER,
      options: { paramTypes: parsed },
    }),
  );
  if (!result.ok) {
    advancedConfigError.value = localizeSqlFormatterConfigError(result.message);
    return;
  }

  updateOption("paramTypes", result.settings.paramTypes);
  setAdvancedDraft(result.settings.paramTypes);
  advancedConfigError.value = "";
}

function importConfig() {
  importError.value = "";
  fileInputRef.value?.click();
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const result = parseSqlFormatterConfig(text);
    if (!result.ok) {
      importError.value = localizeSqlFormatterConfigError(result.message);
      return;
    }
    updateSettings(result.settings);
    toast(t("settings.sqlFormatterImportSuccess"));
  } catch (e: any) {
    importError.value = e?.message || String(e);
  }
}

function exportConfig() {
  const blob = new Blob([serializeSqlFormatterConfig(settings.value)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "dbx-sql-formatter.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyJsonDraft() {
  try {
    await copyToClipboard(cmView?.state.doc.toString() ?? jsonDraft.value);
    toast(t("settings.sqlFormatterCopyJsonSuccess"));
  } catch (e: any) {
    toast(t("settings.sqlFormatterCopyJsonFailed", { message: e?.message || String(e) }), 3000);
  }
}

function applyJsonDraft(): boolean {
  const result = parseSqlFormatterConfig(jsonDraft.value);
  if (!result.ok) {
    jsonValidationMessage.value = localizeSqlFormatterConfigError(result.message);
    emitValidity(false);
    return true;
  }

  const pretty = serializeSqlFormatterConfig(result.settings);
  updateSettings(result.settings);
  setJsonDraftText(pretty);
  jsonValidationMessage.value = "";
  emitValidity(true);
  return true;
}

function formatJsonDraft(): boolean {
  const result = parseSqlFormatterConfig(jsonDraft.value);
  if (!result.ok) {
    jsonValidationMessage.value = localizeSqlFormatterConfigError(result.message);
    emitValidity(false);
    return true;
  }

  setJsonDraftText(serializeSqlFormatterConfig(result.settings));
  jsonValidationMessage.value = "";
  emitValidity(true);
  return true;
}

async function loadCodeMirrorModules(): Promise<CodeMirrorModules> {
  if (cmModules) return cmModules;
  const [view, state, langJson, commands, search] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-json"), import("@codemirror/commands"), import("@codemirror/search")]);
  cmModules = { view, state, langJson, commands, search };
  return cmModules;
}

function destroyJsonEditor() {
  cmView?.destroy();
  cmView = null;
  jsonEditorReady.value = false;
  jsonEditorLoadError.value = "";
}

function jsonEditorKeymapExtension(modules: CodeMirrorModules) {
  const { keymap } = modules.view;
  const commands = modules.commands;
  const search = modules.search;
  return keymap.of([...search.searchKeymap, ...commands.historyKeymap, ...commands.defaultKeymap]);
}

async function initJsonEditor() {
  if (cmView || !jsonEditorRef.value) return;
  jsonEditorLoading.value = true;
  jsonEditorLoadError.value = "";
  try {
    const modules = await loadCodeMirrorModules();
    if (activeMode.value !== "json" || cmView || !jsonEditorRef.value) return;

    const { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } = modules.view;
    const { EditorState } = modules.state;
    const { json } = modules.langJson;
    const commands = modules.commands;
    const search = modules.search;

    const state = EditorState.create({
      doc: jsonDraft.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        commands.history(),
        search.search({ top: true }),
        json(),
        jsonEditorKeymapExtension(modules),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          jsonDraft.value = update.state.doc.toString();
          syncJsonDraft(jsonDraft.value);
        }),
        EditorView.theme({
          "&": {
            minHeight: "260px",
            maxHeight: "360px",
            fontSize: "12px",
            border: "1px solid hsl(var(--border))",
            borderRadius: "var(--radius-md)",
            backgroundColor: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
          },
          ".cm-scroller": {
            fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          },
          ".cm-gutters": {
            backgroundColor: "hsl(var(--muted) / 0.35)",
            color: "hsl(var(--muted-foreground))",
            borderRight: "1px solid hsl(var(--border))",
          },
          ".cm-activeLine, .cm-activeLineGutter": {
            backgroundColor: "hsl(var(--muted) / 0.45)",
          },
          ".cm-focused": {
            outline: "2px solid hsl(var(--ring) / 0.35)",
            outlineOffset: "1px",
          },
        }),
      ],
    });

    cmView = new EditorView({ state, parent: jsonEditorRef.value });
    jsonEditorReady.value = true;
  } catch (e: any) {
    jsonEditorReady.value = false;
    jsonEditorLoadError.value = e?.message || String(e);
  } finally {
    jsonEditorLoading.value = false;
  }
}

watch(
  () => settings.value.paramTypes,
  (value) => {
    if (focusedAdvancedOption.value !== "paramTypes") paramTypesDraft.value = stringifyAdvancedOption(value);
  },
  { deep: true, immediate: true },
);

watch(
  () => props.modelValue,
  (value) => {
    if (activeMode.value === "json") {
      const currentDraft = parseSqlFormatterConfig(jsonDraft.value);
      if (currentDraft.ok && serializeSqlFormatterConfig(currentDraft.settings) === serializeSqlFormatterConfig(value)) {
        validateJsonDraft(jsonDraft.value);
        return;
      }
    }

    const text = serializeSqlFormatterConfig(value);
    setJsonDraftText(text);
    if (activeMode.value === "json") validateJsonDraft(text);
  },
  { deep: true },
);

watch(
  activeMode,
  async (mode) => {
    if (mode === "json") {
      validateJsonDraft();
      await nextTick();
      await initJsonEditor();
      return;
    }
    destroyJsonEditor();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  destroyJsonEditor();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <input ref="fileInputRef" type="file" accept="application/json,.json" class="hidden" @change="onImportFile" />
      <Button type="button" variant="outline" size="sm" @click="importConfig">
        <Upload class="mr-2 h-4 w-4" />
        {{ t("settings.sqlFormatterImport") }}
      </Button>
      <Button type="button" variant="outline" size="sm" @click="exportConfig">
        <Download class="mr-2 h-4 w-4" />
        {{ t("settings.sqlFormatterExport") }}
      </Button>
      <Button type="button" variant="outline" size="sm" @click="restoreDefaults">
        <RotateCcw class="mr-2 h-4 w-4" />
        {{ t("settings.sqlFormatterRestoreDefaults") }}
      </Button>
    </div>

    <p v-if="importError" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {{ importError }}
    </p>

    <Tabs v-model="activeMode" class="min-h-0">
      <TabsList class="grid w-full grid-cols-2">
        <TabsTrigger value="form">{{ t("settings.sqlFormatterFormMode") }}</TabsTrigger>
        <TabsTrigger value="json">{{ t("settings.sqlFormatterJsonMode") }}</TabsTrigger>
      </TabsList>

      <TabsContent value="form" class="m-0 flex flex-col gap-4 pt-2">
        <div class="grid gap-4 md:grid-cols-4">
          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterKeywordCase") }}</Label>
            <Select :model-value="settings.keywordCase" @update:model-value="(value: any) => onCaseOption('keywordCase', value)">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in caseOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterFunctionCase") }}</Label>
            <Select :model-value="settings.functionCase" @update:model-value="(value: any) => onCaseOption('functionCase', value)">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in caseOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterDataTypeCase") }}</Label>
            <Select :model-value="settings.dataTypeCase" @update:model-value="(value: any) => onCaseOption('dataTypeCase', value)">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in caseOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterIdentifierCase") }}</Label>
            <Select :model-value="settings.identifierCase" @update:model-value="onIdentifierCase">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in caseOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem_12rem]">
          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterIndent") }}</Label>
            <div class="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" class="justify-center" :class="!settings.useTabs ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="updateOption('useTabs', false)">
                {{ t("settings.sqlFormatterIndentSpaces") }}
              </Button>
              <Button type="button" variant="outline" class="justify-center" :class="settings.useTabs ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="updateOption('useTabs', true)">
                {{ t("settings.sqlFormatterIndentTabs") }}
              </Button>
            </div>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterTabWidth") }}</Label>
            <Select :model-value="String(settings.tabWidth)" @update:model-value="onTabWidth">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="width in tabWidthOptions" :key="width" :value="String(width)">
                  {{ width }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterIndentStyle") }}</Label>
            <Select :model-value="settings.indentStyle" @update:model-value="onIndentStyle">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in indentStyleOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterLogicalOperatorNewline") }}</Label>
            <Select :model-value="settings.logicalOperatorNewline" @update:model-value="onLogicalOperatorNewline">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in logicalOperatorOptions" :key="option.value" :value="option.value">
                  {{ t(option.labelKey) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterExpressionWidth") }}</Label>
            <Select :model-value="String(settings.expressionWidth)" @update:model-value="onExpressionWidth">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="width in expressionWidthOptions" :key="width" :value="String(width)">
                  {{ width }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label>{{ t("settings.sqlFormatterLinesBetweenQueries") }}</Label>
            <Select :model-value="String(settings.linesBetweenQueries)" @update:model-value="onLinesBetweenQueries">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="count in linesBetweenQueriesOptions" :key="count" :value="String(count)">
                  {{ count }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
            <Label for="sql-formatter-dense-operators">{{ t("settings.sqlFormatterDenseOperators") }}</Label>
            <Switch id="sql-formatter-dense-operators" :model-value="settings.denseOperators" @update:model-value="(value: boolean) => updateOption('denseOperators', value)" />
          </div>

          <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
            <Label for="sql-formatter-newline-before-semicolon">
              {{ t("settings.sqlFormatterNewlineBeforeSemicolon") }}
            </Label>
            <Switch id="sql-formatter-newline-before-semicolon" :model-value="settings.newlineBeforeSemicolon" @update:model-value="(value: boolean) => updateOption('newlineBeforeSemicolon', value)" />
          </div>
        </div>

        <div class="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
          <div class="text-sm font-medium">{{ t("settings.sqlFormatterAdvancedOptions") }}</div>
          <div class="space-y-2">
            <Label for="sql-formatter-param-types">{{ t("settings.sqlFormatterParamTypes") }}</Label>
            <textarea
              id="sql-formatter-param-types"
              :value="paramTypesDraft"
              spellcheck="false"
              class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
              @input="onAdvancedJsonInput"
              @focus="onAdvancedJsonFocus"
              @blur="onAdvancedJsonBlur"
            />
          </div>
          <p v-if="advancedConfigError" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {{ advancedConfigError }}
          </p>
        </div>
      </TabsContent>

      <TabsContent value="json" class="m-0 flex min-h-0 flex-col gap-3 pt-2">
        <div class="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" @click="formatJsonDraft">
            <WandSparkles class="mr-2 h-4 w-4" />
            {{ t("settings.sqlFormatterShortcutFormatJson") }}
          </Button>
          <Button type="button" variant="outline" size="sm" @click="copyJsonDraft">
            <Copy class="mr-2 h-4 w-4" />
            {{ t("settings.sqlFormatterCopyJson") }}
          </Button>
          <Button type="button" size="sm" :disabled="!!jsonValidationMessage" @click="applyJsonDraft">
            <Save class="mr-2 h-4 w-4" />
            {{ t("settings.sqlFormatterShortcutApply") }}
          </Button>
          <span v-if="jsonEditorLoading" class="text-xs text-muted-foreground">{{ t("common.loading") }}</span>
        </div>

        <div ref="jsonEditorRef" v-show="jsonEditorReady || jsonEditorLoading" class="min-h-[320px]" />

        <textarea
          v-if="!jsonEditorReady && !jsonEditorLoading"
          :value="jsonDraft"
          spellcheck="false"
          class="min-h-[320px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
          @input="onJsonDraftTextareaInput"
        />

        <p v-if="jsonEditorLoadError" class="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-200">
          {{ t("settings.sqlFormatterJsonEditorLoadFailed", { message: jsonEditorLoadError }) }}
        </p>

        <p v-if="jsonValidationMessage" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ jsonValidationMessage }}
        </p>
      </TabsContent>
    </Tabs>
  </div>
</template>
