<script setup lang="ts">
import { ref, watch, shallowRef, computed } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { useI18n } from "vue-i18n";
import { Settings } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, EDITOR_THEMES, FONT_FAMILIES, type EditorTheme } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

// Local edit state
const editFontFamily = ref(settingsStore.editorSettings.fontFamily);
const editFontSize = ref(settingsStore.editorSettings.fontSize);
const editTheme = ref(settingsStore.editorSettings.theme);

// Sync from store when dialog opens
watch(() => props.open, (open) => {
  if (open) {
    editFontFamily.value = settingsStore.editorSettings.fontFamily;
    editFontSize.value = settingsStore.editorSettings.fontSize;
    editTheme.value = settingsStore.editorSettings.theme;
  }
});

function hasChanges(): boolean {
  return (
    editFontFamily.value !== settingsStore.editorSettings.fontFamily ||
    editFontSize.value !== settingsStore.editorSettings.fontSize ||
    editTheme.value !== settingsStore.editorSettings.theme
  );
}

function applySettings() {
  settingsStore.updateEditorSettings({
    fontFamily: editFontFamily.value,
    fontSize: editFontSize.value,
    theme: editTheme.value,
  });
  emit("update:open", false);
}

function resetDefaults() {
  editFontFamily.value = "'JetBrains Mono', 'Fira Code', monospace";
  editFontSize.value = 13;
  editTheme.value = "one-dark";
}

function onFontFamilyChange(v: any) {
  if (typeof v === 'string') editFontFamily.value = v;
}

function onThemeChange(v: any) {
  if (typeof v === 'string') editTheme.value = v as EditorTheme;
}

// ---------- CodeMirror preview ----------
const previewRef = ref<HTMLDivElement>();
const previewView = shallowRef<EditorViewType | null>(null);

// Reactive settings computed for the preview
const previewSettings = computed(() => ({
  fontFamily: editFontFamily.value,
  fontSize: editFontSize.value,
  theme: editTheme.value,
}));

async function loadTheme(theme: EditorTheme): Promise<Extension> {
  switch (theme) {
    case "one-dark":
      return (await import("@codemirror/theme-one-dark")).oneDark;
    case "vscode-dark":
      return (await import("@uiw/codemirror-theme-vscode")).vscodeDark;
    case "vscode-light":
      return (await import("@uiw/codemirror-theme-vscode")).vscodeLight;
    case "nord":
      return (await import("@uiw/codemirror-theme-nord")).nord;
    case "okaidia":
      return (await import("@uiw/codemirror-theme-okaidia")).okaidia;
    case "material":
      return (await import("@uiw/codemirror-theme-material")).materialDark;
    case "duotone-light":
      return (await import("@uiw/codemirror-theme-duotone")).duotoneLight;
    case "duotone-dark":
      return (await import("@uiw/codemirror-theme-duotone")).duotoneDark;
    case "xcode":
      return (await import("@uiw/codemirror-theme-xcode")).xcodeLight;
    default:
      return (await import("@codemirror/theme-one-dark")).oneDark;
  }
}

const previewSql = `SELECT u.id, u.name
FROM users u
ORDER BY u.id LIMIT 5;`;

let fontSizeComp: import("@codemirror/state").Compartment | null = null;
let fontFamilyComp: import("@codemirror/state").Compartment | null = null;
let themeComp: import("@codemirror/state").Compartment | null = null;
let editorViewModule: typeof import("@codemirror/view") | null = null;

watch(previewSettings, async (ss) => {
  if (
    !previewView.value ||
    !fontSizeComp ||
    !fontFamilyComp ||
    !themeComp ||
    !editorViewModule
  ) return;

  const themeExt = await loadTheme(ss.theme);
  previewView.value.dispatch({
    effects: [
      themeComp.reconfigure(themeExt),
      fontFamilyComp.reconfigure(
        editorViewModule.EditorView.theme({
          "&": { fontSize: `${ss.fontSize}px` },
          ".cm-content": { fontFamily: ss.fontFamily },
        })
      ),
      fontSizeComp.reconfigure(
        editorViewModule.EditorView.theme({
          "&": { fontSize: `${ss.fontSize}px` },
          ".cm-content": { fontFamily: ss.fontFamily },
        })
      ),
    ],
  });
}, { deep: true });

let previewInitialized = false;

watch(previewRef, async (el) => {
  if (!el || previewInitialized) return;
  previewInitialized = true;
  if (previewView.value) return;

  const [
    { EditorView },
    { EditorState, Compartment },
    { sql, MySQL },
    { basicSetup },
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-sql"),
    import("codemirror"),
  ]);

  editorViewModule = { EditorView } as typeof import("@codemirror/view");
  fontSizeComp = new Compartment();
  fontFamilyComp = new Compartment();
  themeComp = new Compartment();

  const ss = previewSettings.value;
  const themeExt = await loadTheme(ss.theme);

  const state = EditorState.create({
    doc: previewSql,
    extensions: [
      basicSetup,
      sql({ dialect: MySQL }),
      themeComp.of(themeExt),
      fontSizeComp.of(
        EditorView.theme({
          "&": { fontSize: `${ss.fontSize}px` },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { fontFamily: ss.fontFamily },
        })
      ),
      fontFamilyComp.of(
        EditorView.theme({
          "&": { fontSize: `${ss.fontSize}px` },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { fontFamily: ss.fontFamily },
        })
      ),
    ],
    // readOnly: true,
  });

  previewView.value = new EditorView({ state, parent: previewRef.value });
});

watch(() => props.open, (open) => {
  if (!open && previewView.value) {
    previewView.value.destroy();
    previewView.value = null;
    previewInitialized = false;
    fontSizeComp = null;
    fontFamilyComp = null;
    themeComp = null;
    editorViewModule = null;
  }
});
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="sm:max-w-[720px] max-h-[calc(100vh-80px)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Settings class="h-4 w-4" />
          {{ t('settings.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-5 py-2">
        <!-- Font Family -->
        <div class="space-y-2">
          <Label>{{ t('settings.fontFamily') }}</Label>
          <Select :model-value="editFontFamily" @update:model-value="onFontFamilyChange">
            <SelectTrigger>
              <SelectValue :placeholder="t('settings.selectFont')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="font in FONT_FAMILIES"
                :key="font.value"
                :value="font.value"
                :style="{ fontFamily: font.value }"
              >
                {{ font.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <!-- Font Size -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <Label>{{ t('settings.fontSize') }}</Label>
            <span class="text-xs text-muted-foreground tabular-nums">{{ editFontSize }}px</span>
          </div>
          <input
            type="range"
            min="10"
            max="24"
            step="1"
            :value="editFontSize"
            @input="editFontSize = Number(($event.target as HTMLInputElement).value)"
            class="w-full accent-primary"
          />
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span>10px</span>
            <span class="flex-1 border-b border-dashed border-muted-foreground/30" />
            <span>24px</span>
          </div>
        </div>

        <Separator />

        <!-- Theme -->
        <div class="space-y-2">
          <Label>{{ t('settings.theme') }}</Label>
          <Select :model-value="editTheme" @update:model-value="onThemeChange">
            <SelectTrigger>
              <SelectValue :placeholder="t('settings.selectTheme')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="theme in EDITOR_THEMES"
                :key="theme.value"
                :value="theme.value"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="h-3 w-3 rounded-full border"
                    :class="theme.dark ? 'bg-foreground border-foreground/20' : 'bg-muted-foreground/30 border-muted-foreground/40'"
                  />
                  {{ theme.label }}
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <!-- Live Preview -->
        <div class="space-y-2">
          <Label>{{ t('settings.preview') }}</Label>
          <div
            class="rounded-md border overflow-auto max-w-full"
            :class="editTheme === 'vscode-light' || editTheme === 'duotone-light' || editTheme === 'xcode' ? 'border-border' : 'border-border/50'"
          >
            <div ref="previewRef" style="height: 160px; min-width: 100%" />
          </div>
        </div>
      </div>

      <DialogFooter class="gap-2 sm:gap-0">
        <Button variant="outline" @click="resetDefaults">
          {{ t('settings.resetDefaults') }}
        </Button>
        <div class="flex-1" />
        <Button variant="outline" @click="emit('update:open', false)">
          {{ t('common.close') }}
        </Button>
        <Button :disabled="!hasChanges()" @click="applySettings">
          {{ t('settings.apply') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
