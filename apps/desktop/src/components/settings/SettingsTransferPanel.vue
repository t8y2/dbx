<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Loader2, Upload } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/composables/useToast";
import { currentLocale } from "@/i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { EditorSettings } from "@/stores/settingsStore";
import {
  buildSettingsTransferFilename,
  MAX_SETTINGS_TRANSFER_FILE_BYTES,
  parseSettingsTransferFile,
  SETTINGS_TRANSFER_CATEGORY_LABEL_KEYS,
  SETTINGS_TRANSFER_FORMAT_VERSION,
  type ParsedSettingsTransfer,
  type SettingsTransferCategoryId,
  type SettingsTransferParseError,
} from "@/lib/settings/settingsTransfer";

// The card owns file interactions and the import confirmation; the settings
// dialog owns the draft, the unapplied-changes check and the apply flow.
const props = defineProps<{
  hasUnappliedChanges: () => boolean;
  buildSavedExportPayload: () => string;
  buildAppliedExportPayload: () => Promise<string | null>;
  applyImportedSettings: (imported: Partial<EditorSettings>) => void;
  getDraftConflictCategories: (imported: Partial<EditorSettings>) => SettingsTransferCategoryId[];
}>();

const { t } = useI18n();
const { toast } = useToast();

const exporting = ref(false);
const importing = ref(false);
const showExportChoiceDialog = ref(false);
const showImportConfirmDialog = ref(false);
const pendingImport = ref<ParsedSettingsTransfer | null>(null);
const pendingImportFileName = ref("");
const pendingImportConflicts = ref<SettingsTransferCategoryId[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);

const busy = computed(() => exporting.value || importing.value);

const pendingImportCategoryLabels = computed(() => formatCategoryList(pendingImport.value?.categories ?? []));
const pendingImportConflictLabels = computed(() => formatCategoryList(pendingImportConflicts.value));

function formatCategoryList(categories: readonly SettingsTransferCategoryId[]): string {
  const labels = categories.map((category) => t(SETTINGS_TRANSFER_CATEGORY_LABEL_KEYS[category]));
  const formatter = new Intl.ListFormat(currentLocale(), { type: "conjunction" });
  return formatter.format(labels);
}

function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Export ---

function onExportClick() {
  if (busy.value) return;
  if (props.hasUnappliedChanges()) {
    showExportChoiceDialog.value = true;
    return;
  }
  void exportSavedSettings();
}

async function exportSavedSettings() {
  showExportChoiceDialog.value = false;
  await writeSettingsFile(props.buildSavedExportPayload());
}

async function exportAppliedSettings() {
  showExportChoiceDialog.value = false;
  exporting.value = true;
  try {
    const payload = await props.buildAppliedExportPayload();
    // Apply failed: the dialog already surfaced the error toast, and the
    // draft must stay editable, so the export is silently aborted here.
    if (payload === null) return;
    await writeSettingsFile(payload);
  } finally {
    exporting.value = false;
  }
}

async function writeSettingsFile(payload: string) {
  exporting.value = true;
  try {
    const saved = await saveTextFile(buildSettingsTransferFilename(), payload);
    // Cancelling the native save dialog is not an error and stays silent.
    if (saved) toast(t("settings.settingsTransferExportSuccess"));
  } catch (error) {
    toast(t("settings.settingsTransferExportFailed", { message: errorMessage(error) }), 5000);
  } finally {
    exporting.value = false;
  }
}

async function saveTextFile(filename: string, contents: string): Promise<boolean> {
  if (isTauriRuntime()) {
    const [{ save }, { writeTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return false;
    await writeTextFile(path, contents);
    return true;
  }
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

// --- Import ---

function onImportClick() {
  if (busy.value) return;
  if (isTauriRuntime()) {
    void importSettingsFromDesktop();
    return;
  }
  fileInputRef.value?.click();
}

async function importSettingsFromDesktop() {
  importing.value = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    const { readTextFile, stat } = await import("@tauri-apps/plugin-fs");
    // Reject oversized files before reading them into memory. If the platform
    // cannot stat the path, fall through and let the parse-time limit decide.
    try {
      const info = await stat(selected);
      if (info.size > MAX_SETTINGS_TRANSFER_FILE_BYTES) {
        notifyFileTooLarge();
        return;
      }
    } catch {
      // stat failures are not fatal; the reader/parse checks still apply.
    }
    const text = await readTextFile(selected);
    handleImportedText(text, fileNameFromPath(selected));
  } catch (error) {
    toast(t("settings.settingsTransferImportReadFailed", { message: errorMessage(error) }), 5000);
  } finally {
    importing.value = false;
  }
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  // Reject oversized files before reading them into memory.
  if (file.size > MAX_SETTINGS_TRANSFER_FILE_BYTES) {
    notifyFileTooLarge();
    return;
  }
  importing.value = true;
  try {
    const text = await file.text();
    handleImportedText(text, file.name);
  } catch (error) {
    toast(t("settings.settingsTransferImportReadFailed", { message: errorMessage(error) }), 5000);
  } finally {
    importing.value = false;
  }
}

function handleImportedText(text: string, fileName: string) {
  const result = parseSettingsTransferFile(text);
  if (!result.ok) {
    toast(translateParseError(result.error), 5000);
    return;
  }
  pendingImport.value = result.value;
  pendingImportFileName.value = fileName;
  pendingImportConflicts.value = props.getDraftConflictCategories(result.value.editorSettings);
  showImportConfirmDialog.value = true;
}

// The pre-read size checks (stat on desktop, File.size in the browser) and
// the parser's own limit share this message.
function notifyFileTooLarge() {
  toast(translateParseError({ code: "too-large" }), 5000);
}

function translateParseError(error: SettingsTransferParseError): string {
  switch (error.code) {
    case "too-large":
      return t("settings.settingsTransferImportFileTooLarge", { limit: formatFileSize(MAX_SETTINGS_TRANSFER_FILE_BYTES) });
    case "invalid-json":
      return t("settings.settingsTransferImportInvalidJson");
    case "unsupported-version":
      return t("settings.settingsTransferImportUnsupportedVersion", { version: error.detail ?? "?", supported: String(SETTINGS_TRANSFER_FORMAT_VERSION) });
    case "invalid-structure":
      return t("settings.settingsTransferImportInvalidStructure");
    case "empty-settings":
      return t("settings.settingsTransferImportEmpty");
    case "invalid-fields":
      return t("settings.settingsTransferImportFieldInvalid", { fields: error.detail ?? "" });
  }
}

function confirmImport() {
  const imported = pendingImport.value;
  if (!imported) return;
  props.applyImportedSettings(imported.editorSettings);
  showImportConfirmDialog.value = false;
  pendingImport.value = null;
  pendingImportConflicts.value = [];
  // The draft is not persisted yet; applying is still the user's job.
  toast(t("settings.settingsTransferImportLoaded"));
}
</script>

<template>
  <div class="rounded-lg border p-4">
    <div class="settings-about-section-header flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 space-y-1">
        <Label>{{ t("settings.settingsTransferTitle") }}</Label>
        <p class="text-sm text-muted-foreground">
          {{ t("settings.settingsTransferDescription") }}
        </p>
      </div>
      <div class="settings-about-section-actions flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" class="shrink-0" :disabled="busy" @click="onExportClick">
          <Loader2 v-if="exporting" class="mr-1 h-3.5 w-3.5 animate-spin" />
          <Download v-else class="mr-1 h-3.5 w-3.5" />
          {{ t("settings.settingsTransferExport") }}
        </Button>
        <Button type="button" variant="outline" size="sm" class="shrink-0" :disabled="busy" @click="onImportClick">
          <Loader2 v-if="importing" class="mr-1 h-3.5 w-3.5 animate-spin" />
          <Upload v-else class="mr-1 h-3.5 w-3.5" />
          {{ t("settings.settingsTransferImport") }}
        </Button>
      </div>
    </div>
    <input ref="fileInputRef" type="file" accept=".json,application/json" class="hidden" @change="handleFileInputChange" />
  </div>

  <!-- Export choice: shown only when the draft has unapplied changes. -->
  <Dialog :open="showExportChoiceDialog" @update:open="(value: boolean) => (showExportChoiceDialog = value)">
    <DialogContent class="sm:max-w-[460px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.settingsTransferExportChoiceTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("settings.settingsTransferExportChoiceMessage") }}</p>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="showExportChoiceDialog = false">
          {{ t("common.cancel") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="busy" @click="exportSavedSettings">
          {{ t("settings.settingsTransferExportChoiceSaved") }}
        </Button>
        <Button size="sm" :disabled="busy" @click="exportAppliedSettings">
          {{ t("settings.settingsTransferExportChoiceApplied") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Import confirmation: preview before anything touches the draft.
       Width is elastic (fit-content) so long category lists stay on one line
       instead of wrapping; capped for narrow viewports. -->
  <Dialog :open="showImportConfirmDialog" @update:open="(value: boolean) => (showImportConfirmDialog = value)">
    <DialogContent class="w-full sm:w-fit sm:min-w-[420px] sm:max-w-[min(90vw,42rem)]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("settings.settingsTransferImportConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="flex flex-col gap-2 text-sm">
        <div class="flex items-start justify-between gap-3">
          <span class="shrink-0 text-muted-foreground">{{ t("settings.settingsTransferImportConfirmFile") }}</span>
          <span class="min-w-0 break-all text-right font-mono text-xs">{{ pendingImportFileName }}</span>
        </div>
        <div class="flex items-start justify-between gap-3">
          <span class="shrink-0 text-muted-foreground">{{ t("settings.settingsTransferImportConfirmSourceVersion") }}</span>
          <span class="min-w-0 break-all text-right font-mono text-xs">{{ pendingImport?.appVersion || t("settings.supportInfoUnknown") }}</span>
        </div>
        <div class="flex items-start justify-between gap-3">
          <span class="shrink-0 text-muted-foreground">{{ t("settings.settingsTransferImportConfirmIncludes") }}</span>
          <span class="min-w-0 text-right">{{ pendingImportCategoryLabels }}</span>
        </div>
      </div>
      <p v-if="pendingImportConflicts.length" class="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
        {{ t("settings.settingsTransferImportConfirmDraftWarning", { categories: pendingImportConflictLabels }) }}
      </p>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="showImportConfirmDialog = false">
          {{ t("common.cancel") }}
        </Button>
        <Button size="sm" @click="confirmImport">
          {{ t("settings.settingsTransferImportConfirmAction") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
