<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import type { CustomTheme, CustomThemeColors } from "@/stores/settingsStore";
import { DEFAULT_CUSTOM_THEME_COLORS, DEFAULT_CUSTOM_THEME_DDL_COLORS } from "@/stores/settingsStore";
import { Plus, Trash2, Copy, Pencil, ChevronDown, Palette } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Props {
  open: boolean;
  themes: CustomTheme[];
  activeThemeId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "save", themes: CustomTheme[], activeId: string): void;
}>();

const { toast } = useToast();
const { t } = useI18n();

const localThemes = ref<CustomTheme[]>([]);
const activeEditId = ref("");
const jsonText = ref("");
const renamingId = ref<string | null>(null);
const renamingName = ref("");

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      localThemes.value = JSON.parse(JSON.stringify(props.themes));
      activeEditId.value = props.activeThemeId;
      syncJson();
    }
  },
);

function syncJson() {
  const theme = localThemes.value.find((t) => t.id === activeEditId.value);
  jsonText.value = JSON.stringify(theme?.colors ?? DEFAULT_CUSTOM_THEME_COLORS, null, 2);
}

watch(activeEditId, syncJson);

const activeTheme = computed(() => localThemes.value.find((t) => t.id === activeEditId.value));

const localColors = computed({
  get: () => activeTheme.value?.colors ?? { ...DEFAULT_CUSTOM_THEME_COLORS },
  set: (colors: CustomThemeColors) => {
    const theme = localThemes.value.find((t) => t.id === activeEditId.value);
    if (theme) theme.colors = { ...colors };
  },
});

watch(
  localThemes,
  () => {
    syncJson();
  },
  { deep: true },
);

const colorItems = [
  { key: "keyword" as const, label: t("settings.customThemeKeyword"), example: "SELECT, WHERE, IF", num: "①" },
  { key: "field" as const, label: t("settings.customThemeField"), example: "id, name, _var", num: "②" },
  { key: "function" as const, label: t("settings.customThemeFunction"), example: "count, upper", num: "③" },
  { key: "string" as const, label: t("settings.customThemeString"), example: "'hello', 'world'", num: "④" },
  { key: "number" as const, label: t("settings.customThemeNumber"), example: "100, 3.14", num: "⑤" },
  { key: "comment" as const, label: t("settings.customThemeComment"), example: "--, /* */", num: "⑥" },
  { key: "table" as const, label: t("settings.customThemeTable"), example: "users, orders", num: "⑦" },
  { key: "operator" as const, label: t("settings.customThemeOperator"), example: "=, >, <>", num: "⑧" },
  { key: "type" as const, label: t("settings.customThemeType"), example: "INTEGER, TEXT", num: "⑨" },
  { key: "builtin" as const, label: t("settings.customThemeBuiltin"), example: "FOUND, SQLERRM", num: "⑩" },
  { key: "background" as const, label: t("settings.customThemeBackground"), example: "Editor background", num: "⑪" },
  { key: "foreground" as const, label: t("settings.customThemeForeground"), example: "Default text color", num: "⑫" },
];

// Preset color themes (including all built-in themes)
const presetThemes = [
  {
    name: "Default",
    colors: { ...DEFAULT_CUSTOM_THEME_COLORS },
  },
  {
    name: "One Dark",
    colors: {
      keyword: "#c678dd",
      field: "#e06c75",
      function: "#61afef",
      string: "#98c379",
      number: "#d19a66",
      comment: "#5c6370",
      table: "#98c379",
      operator: "#56b6c2",
      type: "#e5c07b",
      builtin: "#61afef",
      background: "#282c34",
      foreground: "#abb2bf",
    },
  },
  {
    name: "VS Code Dark+",
    colors: {
      keyword: "#569cd6",
      field: "#9cdcfe",
      function: "#dcdcaa",
      string: "#ce9178",
      number: "#b5cea8",
      comment: "#6a9955",
      table: "#ce9178",
      operator: "#d4d4d4",
      type: "#4ec9b0",
      builtin: "#dcdcaa",
      background: "#1e1e1e",
      foreground: "#9cdcfe",
    },
  },
  {
    name: "Nord",
    colors: {
      keyword: "#5e81ac",
      field: "#88c0d0",
      function: "#8fbcbb",
      string: "#a3be8c",
      number: "#b48ead",
      comment: "#4c566a",
      table: "#a3be8c",
      operator: "#a3be8c",
      type: "#ebcb8b",
      builtin: "#8fbcbb",
      background: "#2e3440",
      foreground: "#d8dee9",
    },
  },
  {
    name: "Okaidia",
    colors: {
      keyword: "#f92672",
      field: "#a6e22e",
      function: "#fd971f",
      string: "#e6db74",
      number: "#ae81ff",
      comment: "#8292a2",
      table: "#e6db74",
      operator: "#f92672",
      type: "#66d9ef",
      builtin: "#fd971f",
      background: "#272822",
      foreground: "#f8f8f2",
    },
  },
  {
    name: "Material",
    colors: {
      keyword: "#cf6edf",
      field: "#56c8d8",
      function: "#56c8d8",
      string: "#a3be8c",
      number: "#ffad42",
      comment: "#808080",
      table: "#a3be8c",
      operator: "#cf6edf",
      type: "#ffad42",
      builtin: "#56c8d8",
      background: "#2e3235",
      foreground: "#bdbdbd",
    },
  },
  {
    name: "Dracula",
    colors: {
      keyword: "#ff79c6",
      field: "#8be9fd",
      function: "#50fa7b",
      string: "#f1fa8c",
      number: "#bd93f9",
      comment: "#6272a4",
      table: "#f1fa8c",
      operator: "#ff79c6",
      type: "#8be9fd",
      builtin: "#50fa7b",
      background: "#282a36",
      foreground: "#f8f8f2",
    },
  },
  {
    name: "Solarized Dark",
    colors: {
      keyword: "#cb4b16",
      field: "#268bd2",
      function: "#b58900",
      string: "#2aa198",
      number: "#d33682",
      comment: "#586e75",
      table: "#2aa198",
      operator: "#cb4b16",
      type: "#859900",
      builtin: "#b58900",
      background: "#002b36",
      foreground: "#839496",
    },
  },
  {
    name: "VS Code Light+",
    colors: {
      keyword: "#0000ff",
      field: "#001080",
      function: "#795e26",
      string: "#a31515",
      number: "#098658",
      comment: "#008000",
      table: "#a31515",
      operator: "#000000",
      type: "#267f99",
      builtin: "#795e26",
      background: "#ffffff",
      foreground: "#000000",
    },
  },
  {
    name: "Duotone Light",
    colors: {
      keyword: "#6e4cbd",
      field: "#1a1a1a",
      function: "#6e4cbd",
      string: "#6e4cbd",
      number: "#6e4cbd",
      comment: "#a0a0a0",
      table: "#6e4cbd",
      operator: "#1a1a1a",
      type: "#6e4cbd",
      builtin: "#6e4cbd",
      background: "#faf8f5",
      foreground: "#1a1a1a",
    },
  },
  {
    name: "Duotone Dark",
    colors: {
      keyword: "#9375f5",
      field: "#ddd",
      function: "#9375f5",
      string: "#9375f5",
      number: "#9375f5",
      comment: "#777",
      table: "#9375f5",
      operator: "#ddd",
      type: "#9375f5",
      builtin: "#9375f5",
      background: "#2a2734",
      foreground: "#ddd",
    },
  },
  {
    name: "Xcode",
    colors: {
      keyword: "#ad3da4",
      field: "#5c2699",
      function: "#3d1c77",
      string: "#d12f1b",
      number: "#272ad8",
      comment: "#9ba2aa",
      table: "#d12f1b",
      operator: "#000000",
      type: "#234d97",
      builtin: "#3d1c77",
      background: "#ffffff",
      foreground: "#000000",
    },
  },
];

const selectedPreset = ref("");

function applyPreset() {
  const preset = presetThemes.find((p) => p.name === selectedPreset.value);
  if (!preset) return;

  const theme = localThemes.value.find((t) => t.id === activeEditId.value);
  if (theme) {
    theme.colors = { ...DEFAULT_CUSTOM_THEME_COLORS, ...preset.colors };
    toast(t("settings.customThemeApplied", { name: preset.name }), 2000);
  }
}

// Basic palette colors (similar to Windows color picker)
const basicColors = [
  ["#000000", "#7f7f7f", "#880015", "#ed1c24", "#ff7f27", "#fff200", "#22b14c", "#00a2e8"],
  ["#3f48cc", "#a349a4", "#ffffff", "#c3c3c3", "#b97a57", "#ffaec9", "#ffc90e", "#efe4b0"],
];

const expandedPalette = ref<string | null>(null);

function togglePalette(key: string) {
  expandedPalette.value = expandedPalette.value === key ? null : key;
}

function applyBasicColor(key: keyof CustomThemeColors, color: string) {
  handleColorChange(key, color);
  expandedPalette.value = null;
}

const previewCode = computed(() => {
  const c = localColors.value;
  return [
    { text: "SELECT ", color: c.keyword, num: "①" },
    { text: "id", color: c.field, num: "②" },
    { text: ", ", color: c.operator, num: "⑧" },
    { text: "count", color: c.function, num: "③" },
    { text: "(*) ", color: c.operator, num: "⑧" },
    { text: "FROM ", color: c.keyword, num: "①" },
    { text: "users", color: c.table, num: "⑦" },
    { text: " ", color: "", num: "" },
    { text: "WHERE ", color: c.keyword, num: "①" },
    { text: "status", color: c.field, num: "②" },
    { text: " = ", color: c.operator, num: "⑧" },
    { text: "'active'", color: c.string, num: "④" },
    { text: " ", color: "", num: "" },
    { text: "AND ", color: c.keyword, num: "①" },
    { text: "id", color: c.field, num: "②" },
    { text: " > ", color: c.operator, num: "⑧" },
    { text: "100", color: c.number, num: "⑤" },
    { text: ";", color: c.operator, num: "⑧" },
  ];
});

function handleColorChange(key: keyof CustomThemeColors, value: string) {
  const theme = localThemes.value.find((t) => t.id === activeEditId.value);
  if (theme) {
    theme.colors = { ...theme.colors, [key]: value };
  }
}

function handleJsonChange() {
  try {
    const parsed = JSON.parse(jsonText.value);
    const theme = localThemes.value.find((t) => t.id === activeEditId.value);
    if (theme) {
      theme.colors = { ...DEFAULT_CUSTOM_THEME_COLORS, ...parsed };
    }
  } catch {
    // Invalid JSON, ignore
  }
}

function handleSave() {
  emit(
    "save",
    localThemes.value.map((t) => ({ ...t })),
    activeEditId.value,
  );
  emit("update:open", false);
}

function handleAddTheme() {
  const id = `custom-${Date.now()}`;
  const name = `${t("settings.customThemeDefaultName")} ${localThemes.value.length + 1}`;
  localThemes.value.push({
    id,
    name,
    colors: { ...DEFAULT_CUSTOM_THEME_COLORS },
    ddlColors: { ...DEFAULT_CUSTOM_THEME_DDL_COLORS },
  });
  activeEditId.value = id;
}

function handleDeleteTheme(id: string) {
  if (localThemes.value.length <= 1) {
    toast(t("settings.customThemeKeepOne"), 3000);
    return;
  }
  localThemes.value = localThemes.value.filter((t) => t.id !== id);
  if (activeEditId.value === id) {
    activeEditId.value = localThemes.value[0]?.id ?? "";
  }
}

function handleDuplicateTheme(theme: CustomTheme) {
  const id = `custom-${Date.now()}`;
  localThemes.value.push({
    id,
    name: `${theme.name}${t("settings.customThemeCopySuffix")}`,
    colors: { ...theme.colors },
    ddlColors: { ...(theme.ddlColors ?? DEFAULT_CUSTOM_THEME_DDL_COLORS) },
  });
  activeEditId.value = id;
}

function startRename(theme: CustomTheme) {
  renamingId.value = theme.id;
  renamingName.value = theme.name;
}

function confirmRename() {
  if (!renamingId.value) return;
  const theme = localThemes.value.find((t) => t.id === renamingId.value);
  if (theme && renamingName.value.trim()) {
    theme.name = renamingName.value.trim();
  }
  renamingId.value = null;
  renamingName.value = "";
}

function cancelRename() {
  renamingId.value = null;
  renamingName.value = "";
}

function handleExport() {
  const theme = localThemes.value.find((t) => t.id === activeEditId.value);
  if (!theme) return;
  const blob = new Blob([JSON.stringify(theme.colors, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dbx-theme-${theme.name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImport() {
  try {
    const parsed = JSON.parse(jsonText.value);
    const theme = localThemes.value.find((t) => t.id === activeEditId.value);
    if (theme) {
      theme.colors = { ...DEFAULT_CUSTOM_THEME_COLORS, ...parsed };
    }
  } catch (e) {
    toast(t("settings.customThemeJsonError"), 3000);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[860px] max-h-[90vh] overflow-hidden flex flex-col">
      <DialogHeader>
        <DialogTitle>{{ t("settings.customThemeTitle") }}</DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 flex gap-4">
        <!-- Theme list sidebar -->
        <div class="w-48 shrink-0 flex flex-col gap-2">
          <div class="text-sm font-medium px-1">{{ t("settings.customThemeMyThemes") }}</div>
          <div class="flex-1 overflow-y-auto space-y-1 pr-1">
            <div v-for="theme in localThemes" :key="theme.id" class="group flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer text-sm" :class="activeEditId === theme.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'" @click="activeEditId = theme.id">
              <div class="flex-1 min-w-0">
                <div v-if="renamingId === theme.id" class="flex items-center gap-1" @click.stop>
                  <Input v-model="renamingName" class="h-6 text-xs px-1 py-0" @keydown.enter="confirmRename" @keydown.esc="cancelRename" @blur="confirmRename" autofocus />
                </div>
                <div v-else class="truncate">{{ theme.name }}</div>
              </div>
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" class="h-5 w-5" @click.stop="startRename(theme)">
                  <Pencil class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click.stop="handleDuplicateTheme(theme)">
                  <Copy class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click.stop="handleDeleteTheme(theme.id)">
                  <Trash2 class="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" class="w-full gap-1" @click="handleAddTheme">
            <Plus class="h-4 w-4" />
            {{ t("settings.customThemeNewTheme") }}
          </Button>
        </div>

        <!-- Edit area -->
        <div class="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
          <Tabs defaultValue="visual" class="w-full flex-1 min-h-0 flex flex-col">
            <TabsList class="grid w-full grid-cols-2">
              <TabsTrigger value="visual">{{ t("settings.customThemeVisualEdit") }}</TabsTrigger>
              <TabsTrigger value="json">{{ t("settings.customThemeJsonConfig") }}</TabsTrigger>
            </TabsList>

            <TabsContent value="visual" class="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1">
              <!-- Preview area -->
              <div class="rounded-lg border bg-black/50 p-5 font-mono text-base">
                <div class="mb-2 text-sm text-muted-foreground">{{ t("settings.customThemeLivePreview") }}</div>
                <div class="leading-relaxed text-lg">
                  <span v-for="(token, i) in previewCode" :key="i" :style="{ color: token.color }" class="inline">
                    {{ token.text }}<sup v-if="token.num" class="text-xl opacity-60">{{ token.num }}</sup>
                  </span>
                </div>
                <div class="mt-2 text-lg" :style="{ color: localColors.comment }"><sup class="text-xl">⑥</sup> -- {{ t("settings.customThemePreviewExample") }}</div>
              </div>

              <!-- Preset color schemes -->
              <div class="flex items-center gap-2 rounded-lg border p-3 bg-muted/30">
                <Palette class="h-4 w-4 text-muted-foreground shrink-0" />
                <span class="text-sm text-muted-foreground shrink-0">{{ t("settings.customThemePreset") }}:</span>
                <Select v-model="selectedPreset" class="flex-1">
                  <SelectTrigger class="h-8 text-sm">
                    <SelectValue :placeholder="t('settings.customThemeSelectPreset')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="preset in presetThemes" :key="preset.name" :value="preset.name">
                      {{ preset.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" class="h-8 shrink-0" @click="applyPreset">
                  <Copy class="mr-1 h-3 w-3" />
                  {{ t("settings.customThemeApply") }}
                </Button>
              </div>

              <!-- Color configuration list -->
              <div class="grid grid-cols-2 gap-3">
                <div v-for="item in colorItems" :key="item.key" class="relative flex items-center gap-3 rounded-lg border p-3">
                  <span class="text-xl font-bold w-8 text-center shrink-0">{{ item.num }}</span>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm">{{ item.label }}</div>
                    <div class="text-xs text-muted-foreground truncate">{{ item.example }}</div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <!-- Color square + dropdown arrow -->
                    <div class="relative">
                      <button type="button" class="flex items-center gap-0.5 rounded border p-0.5 hover:bg-muted transition-colors" @click.stop="togglePalette(item.key)">
                        <div class="h-6 w-6 rounded-sm" :style="{ backgroundColor: localColors[item.key] }" />
                        <ChevronDown class="h-3 w-3 text-muted-foreground pointer-events-none" />
                      </button>
                      <!-- Palette popup -->
                      <div v-if="expandedPalette === item.key" class="absolute right-0 top-full z-50 mt-1 rounded-lg border bg-popover p-2 shadow-lg" @click.stop>
                        <div class="space-y-1">
                          <div v-for="(row, rowIndex) in basicColors" :key="rowIndex" class="flex gap-1">
                            <button v-for="color in row" :key="color" type="button" class="h-5 w-5 rounded-sm border border-border/50 hover:scale-110 transition-transform" :style="{ backgroundColor: color }" @click="applyBasicColor(item.key, color)" />
                          </div>
                        </div>
                        <div class="mt-2 pt-2 border-t flex items-center gap-2">
                          <input type="color" :value="localColors[item.key]" @input="handleColorChange(item.key, ($event.target as HTMLInputElement).value)" class="h-6 w-6 cursor-pointer rounded border-0 p-0" />
                          <input type="text" :value="localColors[item.key]" @input="handleColorChange(item.key, ($event.target as HTMLInputElement).value)" class="w-20 rounded border px-2 py-0.5 text-xs font-mono" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="json" class="space-y-4 flex-1 min-h-0 flex flex-col">
              <textarea v-model="jsonText" @blur="handleJsonChange" class="flex-1 w-full rounded-lg border bg-black/50 p-4 font-mono text-sm min-h-[360px]" spellcheck="false" />
              <div class="flex gap-2">
                <Button variant="outline" size="sm" @click="handleImport">{{ t("settings.customThemePasteImport") }}</Button>
                <Button variant="outline" size="sm" @click="handleExport">{{ t("settings.customThemeExportJson") }}</Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <DialogFooter class="gap-2">
        <Button variant="outline" @click="emit('update:open', false)">{{ t("settings.cancel") }}</Button>
        <Button @click="handleSave">{{ t("settings.customThemeSaveAndApply") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
