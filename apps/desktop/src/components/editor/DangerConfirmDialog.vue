<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Copy, Loader2, TextWrap } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useDialogEditorFocusRestore } from "@/composables/useDialogEditorFocusRestore";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { copyToClipboard } from "@/lib/common/clipboard";
import { createBoundedTextPreview } from "@/lib/common/boundedTextPreview";

const DANGER_PREVIEW_MAX_CHARACTERS = 8192;
const DANGER_PREVIEW_MAX_LINES = 200;

const { t } = useI18n();
const { highlight } = useSqlHighlighter();

const open = defineModel<boolean>("open", { default: false });
const suppressFuturePrompts = defineModel<boolean>("suppressFuturePrompts", { default: false });
const wrap = ref(true);
const copied = ref(false);

const { onCloseAutoFocus: onDangerDialogCloseAutoFocus } = useDialogEditorFocusRestore(open);

const props = withDefaults(
  defineProps<{
    sql?: string;
    copySql?: string | (() => string);
    title?: string;
    message?: string;
    details?: string;
    detailsText?: string;
    confirmLabel?: string;
    showSuppressToggle?: boolean;
    suppressToggleLabel?: string;
    loading?: boolean;
    closeOnConfirm?: boolean;
    cancelable?: boolean;
    cancelRunningLoading?: boolean;
    /** Holds the confirm button back until the caller's own precondition is met (e.g. the operator typed the target name). */
    confirmDisabled?: boolean;
    /**
     * Controls which element should receive focus when the dialog opens.
     * - "confirm": Focus the confirm button (default) if not disabled or loading.
     * - "cancel": Focus the cancel button.
     * - "default": Do not override default focus behavior (Reka UI will focus the first tabbable element).
     */
    initialFocus?: "confirm" | "cancel" | "default";
  }>(),
  {
    sql: "",
    copySql: "",
    title: "",
    message: "",
    details: "",
    detailsText: "",
    confirmLabel: "",
    showSuppressToggle: false,
    suppressToggleLabel: "",
    loading: false,
    closeOnConfirm: true,
    cancelable: false,
    cancelRunningLoading: false,
    confirmDisabled: false,
    initialFocus: "confirm",
  },
);

const emit = defineEmits<{
  confirm: [];
  "cancel-running": [];
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

const confirmButtonRef = ref<ComponentPublicInstance | HTMLButtonElement | null>(null);
const cancelButtonRef = ref<ComponentPublicInstance | HTMLButtonElement | null>(null);

function focusButton(buttonRef: ComponentPublicInstance | HTMLButtonElement | null) {
  const el = buttonRef instanceof HTMLElement ? buttonRef : (buttonRef?.$el as HTMLElement | null);
  el?.focus?.();
}

function onDangerDialogOpenAutoFocus(event: Event) {
  if (props.initialFocus === "default") return;
  if (props.initialFocus === "cancel") {
    event.preventDefault();
    focusButton(cancelButtonRef.value);
    return;
  }
  if (!props.confirmDisabled && !props.loading) {
    event.preventDefault();
    focusButton(confirmButtonRef.value);
  }
}

function onConfirm() {
  // Guard here as well as on the button: a disabled button still fires on some
  // synthetic/keyboard paths, and this one gates a destructive operation.
  if (props.loading || props.confirmDisabled) return;
  if (props.closeOnConfirm) open.value = false;
  emit("confirm");
}

async function copyFullCode() {
  const copySql = typeof props.copySql === "function" ? props.copySql() : props.copySql;
  await copyToClipboard(copySql || code.value);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[480px]" @open-auto-focus="onDangerDialogOpenAutoFocus" @close-auto-focus="onDangerDialogCloseAutoFocus">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5" />
          {{ title || t("dangerDialog.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="py-4 min-w-0">
        <p class="text-sm text-muted-foreground mb-3">{{ message || t("dangerDialog.message") }}</p>
        <p v-if="detailsText" class="text-xs text-muted-foreground mb-3 whitespace-pre-line max-h-40 overflow-auto">{{ detailsText }}</p>
        <slot name="options" />
        <div v-if="code" data-testid="danger-code-container" class="min-w-0">
          <div data-testid="danger-code-actions" class="mb-1 flex items-center justify-end gap-0.5">
            <Button variant="ghost" size="icon-xs" class="h-6 w-6 text-muted-foreground" :title="t('dangerDialog.copyFullText')" @click="copyFullCode">
              <Check v-if="copied" class="h-3.5 w-3.5 text-emerald-600" />
              <Copy v-else class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon-xs" class="h-6 w-6" :class="wrap ? 'text-foreground bg-accent' : 'text-muted-foreground'" :title="t('dangerDialog.wrapLines')" @click="wrap = !wrap">
              <TextWrap class="h-3.5 w-3.5" />
            </Button>
          </div>
          <div data-native-clipboard data-testid="danger-code-preview" class="max-h-40 min-w-0 overflow-auto rounded bg-muted px-3 py-3 text-xs font-mono">
            <pre class="font-inherit" :class="wrap ? 'w-full whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'" v-html="highlightedHead" />
            <div v-if="preview.truncated" data-testid="danger-preview-truncated" class="my-2 rounded border border-border/70 bg-background/70 px-2 py-1.5 text-center text-[11px] leading-4 text-muted-foreground whitespace-normal">
              {{ t("dangerDialog.previewTruncated", { lines: preview.omittedLines.toLocaleString(), characters: preview.omittedCharacters.toLocaleString() }) }}
            </div>
            <pre v-if="preview.tail" class="font-inherit" :class="wrap ? 'w-full whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'" v-html="highlightedTail" />
          </div>
        </div>
        <div v-if="showSuppressToggle" class="mt-3 flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
          <Label for="danger-confirm-suppress" class="text-sm leading-5">{{ suppressToggleLabel || t("dangerDialog.suppressFuturePrompts") }}</Label>
          <Switch id="danger-confirm-suppress" v-model="suppressFuturePrompts" />
        </div>
      </div>

      <DialogFooter>
        <Button v-if="loading && cancelable" ref="cancelButtonRef" variant="outline" :disabled="cancelRunningLoading" @click="$emit('cancel-running')">
          <Loader2 v-if="cancelRunningLoading" class="h-3.5 w-3.5 animate-spin" />
          {{ t("dangerDialog.cancelRunning") }}
        </Button>
        <Button v-else ref="cancelButtonRef" variant="outline" :disabled="loading" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button ref="confirmButtonRef" variant="destructive" class="gap-1.5" :disabled="loading || confirmDisabled" @click="onConfirm">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          {{ confirmLabel || t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
