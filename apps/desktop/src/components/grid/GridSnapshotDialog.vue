<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Camera, Check, ClipboardCopy, Download, Moon, RotateCcw, Sun } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { copyPngDataUrlToClipboard, gridSnapshotMetadataControlState, renderGridSnapshotHtml, savePngDataUrlToFile, snapshotElementToPng, type GridSnapshotSource } from "@/lib/gridSnapshot/gridSnapshot";

const { t } = useI18n();
const { toast } = useToast();
const { isDark } = useTheme();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ source: GridSnapshotSource | null }>();

const appearance = ref<"light" | "dark">(isDark.value ? "dark" : "light");
const showTrafficLights = ref(true);
const showFieldNames = ref(true);
const showColumnTypes = ref(false);
const showColumnDetails = ref(false);
const showRowNumbers = ref(true);
const wrapCells = ref(false);
const transpose = ref(false);
const compact = ref(false);
const title = ref("");
const snapshotHtml = ref("");
const previewWrapRef = ref<HTMLDivElement>();
const exporting = ref(false);
const copied = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const cellCount = computed(() => props.source?.rows.reduce((sum, row) => sum + row.length, 0) ?? 0);
const hasColumnTypes = computed(() => props.source?.columnTypes?.some(Boolean) === true);
const hasColumnDetails = computed(() => props.source?.columnDetails?.some(Boolean) === true);
const metadataControls = computed(() =>
  gridSnapshotMetadataControlState({
    showFieldNames: showFieldNames.value,
    hasColumnTypes: hasColumnTypes.value,
    hasColumnDetails: hasColumnDetails.value,
  }),
);

watch(
  metadataControls,
  (state) => {
    if (state.columnTypesDisabled) showColumnTypes.value = false;
    if (state.columnDetailsDisabled) showColumnDetails.value = false;
  },
  { immediate: true },
);

function snapshotRoot(): HTMLElement | null {
  return previewWrapRef.value?.querySelector<HTMLElement>(".dbx-grid-snapshot") ?? null;
}

function renderSnapshot() {
  if (!open.value || !props.source) return;
  snapshotHtml.value = renderGridSnapshotHtml(
    { ...props.source, title: title.value.trim() || props.source.title },
    {
      appearance: appearance.value,
      showTrafficLights: showTrafficLights.value,
      showFieldNames: showFieldNames.value,
      showColumnTypes: showColumnTypes.value,
      showColumnDetails: showColumnDetails.value,
      showRowNumbers: showRowNumbers.value,
      wrapCells: wrapCells.value,
      transpose: transpose.value,
      fieldNameLabel: t("gridSnapshot.fieldNames"),
      compact: compact.value,
    },
  );
}

function resetSnapshotOptions() {
  if (titleDebounceTimer) {
    clearTimeout(titleDebounceTimer);
    titleDebounceTimer = null;
  }
  appearance.value = isDark.value ? "dark" : "light";
  showTrafficLights.value = true;
  showFieldNames.value = true;
  showColumnTypes.value = false;
  showColumnDetails.value = false;
  showRowNumbers.value = true;
  wrapCells.value = false;
  transpose.value = false;
  compact.value = false;
  title.value = props.source?.title ?? "";
  copied.value = false;
  if (copyResetTimer) {
    clearTimeout(copyResetTimer);
    copyResetTimer = null;
  }
  renderSnapshot();
}

watch(
  open,
  (isOpen) => {
    if (isOpen) resetSnapshotOptions();
  },
  { immediate: true },
);
watch([open, () => props.source, appearance, showTrafficLights, showFieldNames, showColumnTypes, showColumnDetails, showRowNumbers, wrapCells, transpose, compact], renderSnapshot, { immediate: true });
watch(title, () => {
  if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
  titleDebounceTimer = setTimeout(renderSnapshot, 250);
});
onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer);
  if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
});

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "grid-snapshot";
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
      toast(t("gridSnapshot.copied"));
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => (copied.value = false), 2000);
    } else {
      const base = sanitizeFileName(title.value || props.source?.title || "grid-snapshot");
      if (await savePngDataUrlToFile(dataUrl, `${base}-${Date.now()}.png`)) toast(t("gridSnapshot.saved"));
    }
  } catch (e: any) {
    toast(t("gridSnapshot.failed", { message: e?.message || String(e) }), 5000);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[calc(var(--dbx-viewport-height)-2rem)] flex-col overflow-hidden border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[980px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2"><Camera class="h-5 w-5 text-primary" />{{ t("gridSnapshot.title") }}</DialogTitle>
      </DialogHeader>
      <div v-if="open && props.source" class="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div ref="previewWrapRef" class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3"><div v-html="snapshotHtml" class="flex w-max min-w-[320px] flex-none" /></div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{{ t("gridSnapshot.rows", { count: props.source.rows.length }) }}</span
            ><span>{{ t("gridSnapshot.columns", { count: props.source.columns.length }) }}</span
            ><span>{{ t("gridSnapshot.cells", { count: cellCount }) }}</span>
          </div>
        </div>
        <div class="w-full shrink-0 space-y-3 md:w-56">
          <div class="space-y-2">
            <Label class="block text-[11px] font-medium text-muted-foreground">{{ t("gridSnapshot.appearance") }}</Label>
            <div class="grid gap-1.5">
              <Label class="text-xs">{{ t("gridSnapshot.theme") }}</Label>
              <div class="flex gap-1.5">
                <Button size="sm" variant="outline" class="h-7 flex-1 gap-1 text-[11px]" :class="{ 'border-primary text-primary': appearance === 'light' }" @click="appearance = 'light'"><Sun class="h-3 w-3" />{{ t("codeSnapshot.themeLight") }}</Button
                ><Button size="sm" variant="outline" class="h-7 flex-1 gap-1 text-[11px]" :class="{ 'border-primary text-primary': appearance === 'dark' }" @click="appearance = 'dark'"><Moon class="h-3 w-3" />{{ t("codeSnapshot.themeDark") }}</Button>
              </div>
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.windowControls") }}</Label
              ><Switch v-model="showTrafficLights" />
            </div>
          </div>

          <div class="space-y-2 border-t pt-3">
            <Label class="block text-[11px] font-medium text-muted-foreground">{{ t("gridSnapshot.layout") }}</Label>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.transpose") }}</Label
              ><Switch v-model="transpose" />
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.fieldNames") }}</Label
              ><Switch v-model="showFieldNames" />
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.rowNumbers") }}</Label
              ><Switch v-model="showRowNumbers" />
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.wrapCells") }}</Label
              ><Switch v-model="wrapCells" />
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.compact") }}</Label
              ><Switch v-model="compact" />
            </div>
          </div>

          <div class="space-y-2 border-t pt-3">
            <Label class="block text-[11px] font-medium text-muted-foreground">{{ t("gridSnapshot.fieldMetadata") }}</Label>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.columnTypes") }}</Label
              ><Switch v-model="showColumnTypes" :disabled="metadataControls.columnTypesDisabled" />
            </div>
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("gridSnapshot.columnDetails") }}</Label
              ><Switch v-model="showColumnDetails" :disabled="metadataControls.columnDetailsDisabled" />
            </div>
          </div>

          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("gridSnapshot.titleLabel") }}</Label
            ><Input v-model="title" class="h-8 text-xs" :placeholder="t('gridSnapshot.titlePlaceholder')" />
          </div>
        </div>
      </div>
      <DialogFooter class="sm:justify-between">
        <Button variant="outline" :disabled="exporting" @click="resetSnapshotOptions"><RotateCcw class="mr-1.5 h-4 w-4" />{{ t("gridSnapshot.reset") }}</Button>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" @click="open = false">{{ t("codeSnapshot.close") }}</Button>
          <Button variant="outline" :disabled="exporting" @click="exportSnapshot('clipboard')"><Check v-if="copied" class="mr-1.5 h-4 w-4 text-green-500" /><ClipboardCopy v-else class="mr-1.5 h-4 w-4" />{{ copied ? t("gridSnapshot.copied") : t("codeSnapshot.copy") }}</Button>
          <Button :disabled="exporting" @click="exportSnapshot('file')"><Download class="mr-1.5 h-4 w-4" />{{ t("codeSnapshot.save") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
