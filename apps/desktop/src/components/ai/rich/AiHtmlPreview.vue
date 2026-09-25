<script setup lang="ts">
import { ref } from "vue";
import { AlertTriangle, Check, Copy, Download, Maximize2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { acknowledgeAiHtmlCopyRisk, isAiHtmlCopyRiskAcknowledged } from "@/lib/ai/richContent/aiHtmlPreview";

const props = defineProps<{
  /** Raw AI html fence body — what "copy source" puts on the clipboard. */
  content: string;
  /** `buildSafeHtmlPreview(content)` — shown in the iframe and written by "Save Safe HTML". */
  document: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const copied = ref(false);
const previewExpanded = ref(false);
// Inline confirmation instead of a modal: the first copy attempt arms the risk
// strip; confirming copies (optionally remembering the choice for the
// session), canceling keeps the clipboard untouched.
const showCopyConfirm = ref(false);
const rememberChoice = ref(false);

function copySource() {
  if (!isAiHtmlCopyRiskAcknowledged()) {
    showCopyConfirm.value = true;
    return;
  }
  void warnAfterCopy();
}

// Later copies skip the confirmation but keep a visible risk reminder — only
// when the copy actually succeeded.
async function warnAfterCopy() {
  if (await doCopy()) toast(t("ai.htmlCopyRiskToast"));
}

function confirmCopy() {
  if (rememberChoice.value) acknowledgeAiHtmlCopyRisk();
  showCopyConfirm.value = false;
  void doCopy();
}

function cancelCopy() {
  showCopyConfirm.value = false;
  rememberChoice.value = false;
}

async function doCopy(): Promise<boolean> {
  try {
    await copyToClipboard(props.content);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
    return true;
  } catch {
    // The raw AI HTML is the sensitive payload: do not cover up a clipboard
    // failure with a success-looking toast, and keep the preview usable if
    // the host denies clipboard access.
    return false;
  }
}

// Saves the WRAPPED safe document (inlined CSP), never the raw source: even
// once the file is opened outside the iframe sandbox the CSP still blocks
// scripts and network access.
async function saveSafeHtml() {
  try {
    await saveTextFile(props.document, "dbx-ai-html-preview.html", "HTML", "html");
  } catch {
    toast(t("ai.htmlSaveFailed"));
  }
}
</script>

<template>
  <!-- `sandbox=""` is the strongest sandbox: no allow-scripts (nothing executes),
       no allow-same-origin (no origin/cookie/storage access), no forms or
       popups. The `srcdoc` is the CSP-wrapped standalone document — identical
       bytes to the "Save Safe HTML" payload, so what is previewed is exactly
       what gets saved. -->
  <section class="my-2 flex min-h-60 h-[clamp(15rem,35vw,20rem)] flex-col overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700/50 dark:bg-zinc-900" :aria-label="t('ai.htmlPreviewLabel')">
    <div class="flex h-8 items-center justify-end gap-1 border-b border-zinc-200 px-2 dark:border-zinc-700/50">
      <button type="button" class="mr-auto rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100" :title="t('ai.htmlExpandPreview')" :aria-label="t('ai.htmlExpandPreview')" @click="previewExpanded = true">
        <Maximize2 class="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
        :title="copied ? t('ai.copied') : t('ai.htmlCopySource')"
        :aria-label="copied ? t('ai.copied') : t('ai.htmlCopySource')"
        @click="copySource"
      >
        <Check v-if="copied" class="h-3.5 w-3.5 text-green-500" />
        <Copy v-else class="h-3.5 w-3.5" />
      </button>
      <button type="button" class="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100" :title="t('ai.htmlSaveSafe')" :aria-label="t('ai.htmlSaveSafe')" @click="saveSafeHtml">
        <Download class="h-3.5 w-3.5" />
      </button>
    </div>
    <div v-if="showCopyConfirm" class="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200" role="alertdialog" :aria-label="t('ai.htmlCopySource')">
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="leading-snug">{{ t("ai.htmlCopyRiskBody") }}</p>
        <div class="mt-1.5 flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-1 select-none">
            <input v-model="rememberChoice" type="checkbox" class="h-3 w-3 accent-amber-600" />
            <span>{{ t("ai.htmlCopyRiskRemember") }}</span>
          </label>
          <span class="flex-1" />
          <button type="button" class="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-500/50 dark:hover:bg-amber-500/20" @click="cancelCopy">{{ t("common.cancel") }}</button>
          <button type="button" class="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700" @click="confirmCopy">{{ t("ai.htmlCopyRiskAccept") }}</button>
        </div>
      </div>
    </div>
    <div class="min-h-0 flex-1">
      <iframe sandbox="" :srcdoc="document" class="h-full w-full bg-white" :title="t('ai.htmlPreviewLabel')" />
    </div>
  </section>

  <!-- The expanded dialog renders the SAME sandboxed document as the inline
       card — identical `sandbox=""` and the identical CSP-wrapped `srcdoc`
       bytes. This is pure UX magnification: the zero-trust boundary does not
       change, there is no path here that hands raw HTML to the OS browser. -->
  <Dialog :open="previewExpanded" @update:open="previewExpanded = $event">
    <!-- Match other large dialogs: override DialogContent's 384px default at
         every breakpoint while keeping 16px viewport gutters. -->
    <DialogContent class="max-w-[min(1100px,calc(100vw-32px))] flex h-[85vh] flex-col">
      <DialogHeader class="shrink-0">
        <DialogTitle>{{ t("ai.htmlPreviewLabel") }}</DialogTitle>
        <DialogDescription>{{ t("ai.htmlExpandPreviewHint") }}</DialogDescription>
      </DialogHeader>
      <div class="min-h-0 flex-1">
        <iframe sandbox="" :srcdoc="document" class="h-full w-full bg-white" :title="t('ai.htmlPreviewLabel')" />
      </div>
    </DialogContent>
  </Dialog>
</template>
