<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Copy, Loader2, TextWrap } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { copyToClipboard } from "@/lib/common/clipboard";
import { createBoundedTextPreview } from "@/lib/common/boundedTextPreview";

const DANGER_PREVIEW_MAX_CHARACTERS = 8192;
const DANGER_PREVIEW_MAX_LINES = 200;

const { t } = useI18n();
const { highlight } = useSqlHighlighter();

const open = defineModel<boolean>("open", { default: false });
const suppressFuturePrompts = defineModel<boolean>("suppressFuturePrompts", { default: false });
const wrap = ref(false);
const copied = ref(false);

const props = withDefaults(
  defineProps<{
    sql?: string;
    title?: string;
    message?: string;
    details?: string;
    detailsText?: string;
    confirmLabel?: string;
    showSuppressToggle?: boolean;
    suppressToggleLabel?: string;
    loading?: boolean;
    closeOnConfirm?: boolean;
  }>(),
  {
    sql: "",
    title: "",
    message: "",
    details: "",
    detailsText: "",
    confirmLabel: "",
    showSuppressToggle: false,
    suppressToggleLabel: "",
    loading: false,
    closeOnConfirm: true,
  },
);

const emit = defineEmits<{
  confirm: [];
}>();

const code = computed(() => props.details || props.sql);
// Keep the confirmation payload intact, but never feed an unbounded script to Shiki or the DOM.
const preview = computed(() => createBoundedTextPreview(code.value, { maxCharacters: DANGER_PREVIEW_MAX_CHARACTERS, maxLines: DANGER_PREVIEW_MAX_LINES }));
const highlightedHead = computed(() => highlight(preview.value.head));
const highlightedTail = computed(() => highlight(preview.value.tail));
const dialogOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (props.loading && !value) return;
    open.value = value;
  },
});

function onConfirm() {
  if (props.loading) return;
  if (props.closeOnConfirm) open.value = false;
  emit("confirm");
}

async function copyFullCode() {
  await copyToClipboard(code.value);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5" />
          {{ title || t("dangerDialog.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="py-4 min-w-0">
        <p class="text-sm text-muted-foreground mb-3">{{ message || t("dangerDialog.message") }}</p>
        <p v-if="detailsText" class="text-xs text-muted-foreground mb-3 whitespace-pre-line">{{ detailsText }}</p>
        <slot name="options" />
        <div v-if="code" class="relative">
          <div class="absolute top-1 right-1 z-10 flex items-center gap-0.5">
            <Button variant="ghost" size="icon-xs" class="h-6 w-6 text-muted-foreground" :title="t('dangerDialog.copyFullText')" @click="copyFullCode">
              <Check v-if="copied" class="h-3.5 w-3.5 text-emerald-600" />
              <Copy v-else class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon-xs" class="h-6 w-6" :class="wrap ? 'text-foreground bg-accent' : 'text-muted-foreground'" :title="t('dangerDialog.wrapLines')" @click="wrap = !wrap">
              <TextWrap class="h-3.5 w-3.5" />
            </Button>
          </div>
          <div data-native-clipboard data-testid="danger-code-preview" class="text-xs bg-muted px-3 pt-3 pb-3 pr-14 rounded overflow-auto max-h-40 min-w-0 font-mono" :class="wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'">
            <pre class="font-inherit whitespace-inherit" v-html="highlightedHead" />
            <div v-if="preview.truncated" data-testid="danger-preview-truncated" class="my-2 rounded border border-border/70 bg-background/70 px-2 py-1.5 text-center text-[11px] leading-4 text-muted-foreground whitespace-normal">
              {{ t("dangerDialog.previewTruncated", { lines: preview.omittedLines.toLocaleString(), characters: preview.omittedCharacters.toLocaleString() }) }}
            </div>
            <pre v-if="preview.tail" class="font-inherit whitespace-inherit" v-html="highlightedTail" />
          </div>
        </div>
        <div v-if="showSuppressToggle" class="mt-3 flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
          <Label for="danger-confirm-suppress" class="text-sm leading-5">{{ suppressToggleLabel || t("dangerDialog.suppressFuturePrompts") }}</Label>
          <Switch id="danger-confirm-suppress" v-model="suppressFuturePrompts" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" class="gap-1.5" :disabled="loading" @click="onConfirm">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          {{ confirmLabel || t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
