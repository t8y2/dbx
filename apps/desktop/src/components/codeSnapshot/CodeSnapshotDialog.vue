<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Camera, Check, ClipboardCopy, Download, Moon, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { renderCodeSnapshotHtml, snapshotElementToPng, copyPngDataUrlToClipboard, savePngDataUrlToFile, type CodeSnapshotSource } from "@/lib/codeSnapshot/codeSnapshot";

const { t } = useI18n();
const { toast } = useToast();
const { isDark } = useTheme();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  source: CodeSnapshotSource | null;
}>();

const STORAGE_KEY = "dbx:code-snapshot-settings";

interface CodeSnapshotUiSettings {
  appearance: "light" | "dark";
  showTrafficLights: boolean;
  showLineNumbers: boolean;
}

function loadUiSettings(): CodeSnapshotUiSettings {
  const fallback: CodeSnapshotUiSettings = {
    appearance: isDark.value ? "dark" : "light",
    showTrafficLights: true,
    showLineNumbers: true,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return fallback;
}

const initialUiSettings = loadUiSettings();
const appearance = ref<"light" | "dark">(initialUiSettings.appearance);
const showTrafficLights = ref(initialUiSettings.showTrafficLights);
const showLineNumbers = ref(initialUiSettings.showLineNumbers);
const title = ref("");

function persistUiSettings() {
  try {
    const settings: CodeSnapshotUiSettings = {
      appearance: appearance.value,
      showTrafficLights: showTrafficLights.value,
      showLineNumbers: showLineNumbers.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
watch([appearance, showTrafficLights, showLineNumbers], persistUiSettings);

const snapshotHtml = ref("");
const previewWrapRef = ref<HTMLDivElement>();
const exporting = ref(false);
const copied = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function snapshotRoot(): HTMLElement | null {
  return previewWrapRef.value?.querySelector<HTMLElement>(".dbx-code-snapshot") ?? null;
}

async function renderSnapshot() {
  if (!open.value || !props.source) return;
  try {
    snapshotHtml.value = await renderCodeSnapshotHtml(
      {
        code: props.source.code,
        lang: props.source.lang,
        title: title.value.trim() || props.source.title,
      },
      {
        appearance: appearance.value,
        showTrafficLights: showTrafficLights.value,
        showLineNumbers: showLineNumbers.value,
      },
    );
  } catch (e: any) {
    snapshotHtml.value = "";
    toast(t("codeSnapshot.failed", { message: e?.message || String(e) }), 5000);
  }
}

// Reset the title for each new snapshot source instead of leaking the
// previous snapshot's title across opens.
watch(
  [open, () => props.source],
  ([isOpen, source]) => {
    if (isOpen && source) title.value = source.title ?? "";
  },
  { immediate: true },
);

// Appearance / toggle options re-render immediately; the title input is
// debounced so typing large code blocks stays responsive.
watch([open, () => props.source, appearance, showTrafficLights, showLineNumbers], renderSnapshot, {
  immediate: true,
});
watch(title, () => {
  if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
  titleDebounceTimer = setTimeout(renderSnapshot, 300);
});

onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer);
  if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
});

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "code-snapshot";
}

async function exportSnapshot(kind: "clipboard" | "file") {
  const root = snapshotRoot();
  if (!root || exporting.value) return;
  exporting.value = true;
  try {
    const dataUrl = await snapshotElementToPng(root);
    if (kind === "clipboard") {
      await copyPngDataUrlToClipboard(dataUrl);
      copied.value = true;
      toast(t("codeSnapshot.copied"));
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copied.value = false;
      }, 2000);
    } else {
      const base = sanitizeFileName(title.value.trim() || (props.source?.title ?? "code-snapshot"));
      const saved = await savePngDataUrlToFile(dataUrl, `${base}-${Date.now()}.png`);
      if (saved) toast(t("codeSnapshot.saved"));
    }
  } catch (e: any) {
    toast(t("codeSnapshot.failed", { message: e?.message || String(e) }), 5000);
  } finally {
    exporting.value = false;
  }
}

const previewVisible = computed(() => open.value && !!props.source);
</script>

<template>
  <Dialog v-model:open="open">
    <!-- 对话框整体限高：高度上限跟随 --dbx-viewport-height（兼容旧版 WebView 中 vh 不准的情况）；
         内部采用纵向 flex 布局，header/footer 固定，只有中间预览区滚动，保证底部按钮始终可见 -->
    <DialogContent class="dbx-code-snapshot-dialog flex max-h-[calc(var(--dbx-viewport-height)-2rem)] flex-col overflow-hidden border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[860px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Camera class="h-5 w-5 text-primary" />
          {{ t("codeSnapshot.title") }}
        </DialogTitle>
      </DialogHeader>

      <!-- min-h-0 flex-1：让内容区占满剩余高度并允许收缩，超高时由预览区内部滚动而不是撑破对话框 -->
      <div v-if="previewVisible" class="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <!-- Snapshot preview -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <!-- 预览容器随父级伸缩（flex-1 + min-h-0），代码/图片过长时仅此处出现滚动条 -->
          <div ref="previewWrapRef" class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3">
            <!-- 截图内容按代码的固有宽度展开，不跟随外层 flex 容器收缩；外层预览容器负责横向滚动 -->
            <div v-html="snapshotHtml" class="flex w-max min-w-[320px] flex-none" />
          </div>
        </div>

        <!-- Options -->
        <div class="w-full shrink-0 space-y-3 md:w-52">
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("codeSnapshot.theme") }}</Label>
            <div class="flex gap-1.5">
              <Button size="sm" variant="outline" class="h-7 flex-1 gap-1 text-[11px]" :class="{ 'border-primary text-primary': appearance === 'light' }" @click="appearance = 'light'">
                <Sun class="h-3 w-3" />
                {{ t("codeSnapshot.themeLight") }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 flex-1 gap-1 text-[11px]" :class="{ 'border-primary text-primary': appearance === 'dark' }" @click="appearance = 'dark'">
                <Moon class="h-3 w-3" />
                {{ t("codeSnapshot.themeDark") }}
              </Button>
            </div>
          </div>

          <div class="flex items-center justify-between gap-2">
            <Label class="text-xs">{{ t("codeSnapshot.windowControls") }}</Label>
            <Switch v-model="showTrafficLights" />
          </div>
          <div class="flex items-center justify-between gap-2">
            <Label class="text-xs">{{ t("codeSnapshot.lineNumbers") }}</Label>
            <Switch v-model="showLineNumbers" />
          </div>

          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("codeSnapshot.titleLabel") }}</Label>
            <Input v-model="title" class="h-8 text-xs" :placeholder="t('codeSnapshot.titlePlaceholder')" />
          </div>
        </div>
      </div>

      <DialogFooter class="dbx-code-snapshot-dialog__footer">
        <Button variant="outline" @click="open = false">{{ t("codeSnapshot.close") }}</Button>
        <Button variant="outline" :disabled="exporting" @click="exportSnapshot('clipboard')">
          <Check v-if="copied" class="mr-1.5 h-4 w-4 text-green-500" />
          <ClipboardCopy v-else class="mr-1.5 h-4 w-4" />
          {{ copied ? t("codeSnapshot.copied") : t("codeSnapshot.copy") }}
        </Button>
        <Button :disabled="exporting" @click="exportSnapshot('file')">
          <Download class="mr-1.5 h-4 w-4" />
          {{ t("codeSnapshot.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
html.dbx-legacy-webview [data-slot="dialog-content"].dbx-code-snapshot-dialog {
  display: flex !important;
  flex-direction: column !important;
  width: calc(100vw - 2rem) !important;
  max-width: 860px !important;
  min-width: 0 !important;
}

html.dbx-legacy-webview .dbx-code-snapshot-dialog__footer {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: flex-end !important;
  flex-wrap: nowrap !important;
}
</style>
