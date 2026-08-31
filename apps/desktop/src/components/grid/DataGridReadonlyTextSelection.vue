<script setup lang="ts">
import { onMounted, ref } from "vue";

const props = defineProps<{
  value: string;
  expanded: boolean;
}>();

const emit = defineEmits<{
  close: [];
  escape: [];
}>();

const inputRef = ref<HTMLInputElement | HTMLTextAreaElement>();

onMounted(() => {
  inputRef.value?.focus({ preventScroll: true });
  inputRef.value?.select();
});

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  emit("escape");
}
</script>

<template>
  <textarea
    v-if="props.expanded"
    ref="inputRef"
    :value="props.value"
    readonly
    data-native-clipboard
    data-readonly-cell-selection="true"
    rows="1"
    spellcheck="false"
    class="cell-readonly-input cell-readonly-input--expanded absolute left-0 top-0 z-10 min-h-full px-2.5 py-1 leading-[18px] outline-none"
    @blur="emit('close')"
    @mousedown.stop
    @click.stop
    @dblclick.stop
    @keydown.stop="onKeydown"
    @paste.prevent.stop
  />
  <input
    v-else
    ref="inputRef"
    :value="props.value"
    readonly
    data-native-clipboard
    data-readonly-cell-selection="true"
    spellcheck="false"
    class="cell-readonly-input absolute inset-0 z-10 px-2.5 py-0 leading-[22px] outline-none"
    @blur="emit('close')"
    @mousedown.stop
    @click.stop
    @dblclick.stop
    @keydown.stop="onKeydown"
    @paste.prevent.stop
  />
</template>

<style scoped>
.cell-readonly-input {
  border: 2px solid var(--primary);
  background-color: var(--background);
  color: var(--foreground);
  font-family: inherit;
  font-size: var(--dbx-table-font-size, 13px);
  cursor: text;
  user-select: text;
}

.cell-readonly-input--expanded {
  left: 7px;
  width: calc(100% - 14px);
  min-height: var(--cell-edit-min-height, 54px);
  max-height: var(--cell-edit-max-height, calc(9.5lh + 10px));
  overflow: auto;
  resize: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-width: 1px;
  border-color: color-mix(in oklab, var(--primary) 62%, var(--border));
  border-radius: var(--dbx-radius-fixed-6);
  box-shadow: 0 12px 30px rgb(0 0 0 / 24%);
}
</style>
