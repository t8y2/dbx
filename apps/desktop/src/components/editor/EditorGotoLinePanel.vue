<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRightToLine } from "@lucide/vue";
import type { EditorView } from "@codemirror/view";
import { currentEditorLineNumber, resolveEditorGotoLine } from "@/lib/editor/editorGotoLine";

const props = defineProps<{
  view: EditorView | null;
}>();

const emit = defineEmits<{
  open: [];
  close: [];
}>();

const { t } = useI18n();

const gotoLineVisible = ref(false);
const gotoLineInput = ref("");
const gotoLineError = ref("");
const gotoLineInputRef = ref<HTMLInputElement>();

function focusInput() {
  void nextTick(() => {
    const input = gotoLineInputRef.value;
    if (!input) return;
    input.focus();
    input.select();
  });
}

function openGotoLine(): boolean {
  const view = props.view;
  if (!view) return false;
  gotoLineVisible.value = true;
  gotoLineError.value = "";
  // 预填当前行：直接回车即回到原处，符合 VS Code 的跳转框行为。
  gotoLineInput.value = String(currentEditorLineNumber(view.state.doc, view.state.selection.main.head));
  emit("open");
  focusInput();
  return true;
}

function closeGotoLine(): boolean {
  if (!gotoLineVisible.value) return false;
  gotoLineVisible.value = false;
  gotoLineError.value = "";
  emit("close");
  props.view?.focus();
  return true;
}

function gotoLine(): boolean {
  const view = props.view;
  if (!view) return false;
  const resolution = resolveEditorGotoLine(gotoLineInput.value, view.state.doc);
  if (!resolution.ok) {
    gotoLineError.value = resolution.reason === "empty" ? t("editor.gotoLine.empty") : t("editor.gotoLine.outOfRange", { total: view.state.doc.lines });
    gotoLineInputRef.value?.focus();
    return false;
  }
  const line = view.state.doc.line(resolution.line);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true, userEvent: "select.gotoLine" });
  closeGotoLine();
  return true;
}

function onGotoLineKeydown(event: KeyboardEvent) {
  // 输入法组合中的回车用于确认候选词，不能当作提交。
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    gotoLine();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeGotoLine();
    return;
  }
  if (gotoLineError.value) gotoLineError.value = "";
}

defineExpose({
  openGotoLine,
  closeGotoLine,
});
</script>

<template>
  <Transition enter-active-class="transition-[transform,opacity] duration-150 will-change-[transform,opacity]" leave-active-class="transition-[transform,opacity] duration-100 will-change-[transform,opacity]" enter-from-class="opacity-0 -translate-y-1" leave-to-class="opacity-0 -translate-y-1">
    <div v-if="gotoLineVisible" class="editor-goto-line-panel absolute right-4 top-3 z-[9999] isolate flex items-center gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-border/60">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground" :title="t('editor.gotoLine.placeholder')" aria-hidden="true">
        <ArrowRightToLine class="h-4 w-4" />
      </span>
      <div class="flex h-8 w-40 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring" :class="gotoLineError && 'border-destructive focus-within:border-destructive'">
        <input
          ref="gotoLineInputRef"
          v-model="gotoLineInput"
          inputmode="numeric"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          :placeholder="t('editor.gotoLine.placeholder')"
          :aria-label="t('editor.gotoLine.placeholder')"
          :aria-invalid="!!gotoLineError"
          @keydown="onGotoLineKeydown"
        />
        <span class="shrink-0 pr-2 text-xs text-muted-foreground">{{ t("editor.gotoLine.total", { total: view?.state.doc.lines ?? 0 }) }}</span>
      </div>
      <span v-if="gotoLineError" class="max-w-48 shrink-0 text-xs text-destructive" aria-live="polite">{{ gotoLineError }}</span>
    </div>
  </Transition>
</template>
