<script setup lang="ts">
import { nextTick, ref } from "vue";
import type { Translate } from "../docsWarnings";
import { renderNote } from "../renderNote";

const props = defineProps<{
  /** Raw markdown. Displayed through renderNote, edited as its source. */
  modelValue: string;
  /**
   * Part 3c renders this same component inside the standalone HTML export,
   * where nothing can be saved. Read-only means the note never turns into a
   * textarea — not a disabled one, none at all.
   */
  readonly: boolean;
  translate: Translate;
}>();

const emit = defineEmits<{
  "update:modelValue": [note: string];
}>();

const editing = ref(false);
const draft = ref("");
const input = ref<HTMLTextAreaElement | null>(null);

async function begin(): Promise<void> {
  if (props.readonly) {
    return;
  }
  draft.value = props.modelValue;
  editing.value = true;
  await nextTick();
  input.value?.focus();
}

function commit(): void {
  editing.value = false;
  // The parent owns the value. Emitting an unchanged note would dirty the
  // annotation file for a click that edited nothing.
  if (draft.value !== props.modelValue) {
    emit("update:modelValue", draft.value);
  }
}

/** Escape abandons the draft; the stored note stays the source of truth. */
function cancel(): void {
  draft.value = props.modelValue;
  editing.value = false;
}
</script>

<template>
  <div class="text-sm text-muted-foreground">
    <textarea v-if="editing" ref="input" v-model="draft" rows="4" class="w-full resize-y rounded border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-ring" @blur="commit()" @keydown.escape="cancel()"></textarea>

    <!-- renderNote is the sanitiser: a note can be a database COMMENT ON value
         the reader never wrote, so its markdown is rendered here and its HTML
         is escaped there. Binding the raw note would hand that comment to the
         DOM verbatim. -->
    <div v-else-if="modelValue.trim() !== ''" class="leading-relaxed" :class="readonly ? '' : 'cursor-text rounded transition-colors hover:bg-muted/30'" :title="readonly ? undefined : translate('docs.editNote')" @click="begin()" v-html="renderNote(modelValue)"></div>

    <button v-else-if="!readonly" type="button" class="rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40" @click="begin()">
      {{ translate("docs.addNote") }}
    </button>
  </div>
</template>
