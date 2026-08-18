<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Check, ChevronDown, GitBranch, Tag } from "@lucide/vue";
import DoltScrollArea from "@/components/dolt/DoltScrollArea.vue";
import type { DoltRef } from "@/lib/dolt/doltVersionControl";

const props = defineProps<{
  modelValue: string;
  options: readonly DoltRef[];
  disabled?: boolean;
  placeholder: string;
  inputLabel: string;
}>();

const emit = defineEmits<{
  commit: [value: string];
}>();

const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const draft = ref(props.modelValue);
const open = ref(false);
const highlightedIndex = ref(0);
const keyboardNavigation = ref(false);

const filteredOptions = computed(() => {
  const query = draft.value.trim().toLowerCase();
  if (!query || query === props.modelValue.toLowerCase()) return props.options;
  return props.options.filter((option) => option.name.toLowerCase().includes(query));
});

watch(
  () => props.modelValue,
  (value) => {
    draft.value = value;
  },
);

watch(filteredOptions, (options) => {
  highlightedIndex.value = Math.min(highlightedIndex.value, Math.max(0, options.length - 1));
});

function showOptions() {
  if (props.disabled) return;
  open.value = true;
  const selectedIndex = filteredOptions.value.findIndex((option) => option.name === props.modelValue);
  highlightedIndex.value = Math.max(0, selectedIndex);
  keyboardNavigation.value = false;
}

function toggleOptions() {
  if (open.value) {
    open.value = false;
    return;
  }
  showOptions();
  void nextTick(() => input.value?.focus());
}

function commitDraft() {
  const revision = draft.value.trim();
  if (!revision) {
    draft.value = props.modelValue;
    open.value = false;
    return;
  }
  draft.value = revision;
  open.value = false;
  if (revision !== props.modelValue) emit("commit", revision);
}

function selectOption(option: DoltRef) {
  draft.value = option.name;
  open.value = false;
  if (option.name !== props.modelValue) emit("commit", option.name);
  void nextTick(() => input.value?.focus());
}

function onInput(event: Event) {
  draft.value = (event.currentTarget as HTMLInputElement).value;
  showOptions();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    const highlighted = keyboardNavigation.value ? filteredOptions.value[highlightedIndex.value] : undefined;
    if (highlighted) {
      selectOption(highlighted);
      return;
    }
    commitDraft();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    draft.value = props.modelValue;
    open.value = false;
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  if (!open.value) showOptions();
  const count = filteredOptions.value.length;
  if (!count) return;
  keyboardNavigation.value = true;
  highlightedIndex.value = (highlightedIndex.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
}

function onBlur() {
  window.setTimeout(() => {
    if (root.value?.contains(document.activeElement)) return;
    commitDraft();
  }, 0);
}

function onDocumentPointerDown(event: PointerEvent) {
  if (root.value?.contains(event.target as Node)) return;
  if (open.value) commitDraft();
}

onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onUnmounted(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <div ref="root" class="dolt-revision-selector">
    <span class="dolt-revision-selector-sizer" aria-hidden="true">{{ draft || placeholder }}</span>
    <div class="dolt-revision-selector-field" :class="{ 'dolt-revision-selector-field-open': open, 'dolt-revision-selector-field-disabled': disabled }">
      <input
        ref="input"
        :value="draft"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        class="dolt-revision-selector-input"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-label="inputLabel"
        :title="draft || placeholder"
        :placeholder="placeholder"
        :disabled="disabled"
        @focus="showOptions"
        @input="onInput"
        @keydown="onKeydown"
        @blur="onBlur"
      />
      <button type="button" class="dolt-revision-selector-toggle" :disabled="disabled" tabindex="-1" :aria-label="inputLabel" @mousedown.prevent @click="toggleOptions">
        <ChevronDown class="h-3.5 w-3.5" />
      </button>
    </div>

    <div v-if="open && filteredOptions.length" class="dolt-revision-selector-options" role="listbox">
      <DoltScrollArea class="max-h-[240px]" scroller-class="p-[3px]">
        <button
          v-for="(option, index) in filteredOptions"
          :key="`${option.kind}:${option.name}`"
          type="button"
          role="option"
          :aria-selected="option.name === modelValue"
          class="dolt-revision-selector-option"
          :class="{ 'dolt-revision-selector-option-highlighted': index === highlightedIndex }"
          @mousedown.prevent="selectOption(option)"
          @mouseenter="highlightedIndex = index"
        >
          <GitBranch v-if="option.kind === 'branch'" class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
          <Tag v-else class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ option.name }}</span>
          <Check v-if="option.name === modelValue" class="h-3.5 w-3.5 text-primary" />
        </button>
      </DoltScrollArea>
    </div>
  </div>
</template>

<style scoped>
.dolt-revision-selector {
  position: relative;
  display: inline-grid;
  min-width: 120px;
  max-width: 220px;
  flex: 0 1 auto;
  grid-template-areas: "control";
}

.dolt-revision-selector-sizer {
  grid-area: control;
  min-width: 0;
  overflow: hidden;
  padding: 0 30px 0 8px;
  visibility: hidden;
  white-space: pre;
  font-family: var(--font-mono);
  font-size: 11px;
}

.dolt-revision-selector-field {
  grid-area: control;
  display: flex;
  width: 100%;
  height: 28px;
  min-width: 0;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--muted) 28%, transparent);
}

.dolt-revision-selector-field:focus-within,
.dolt-revision-selector-field-open {
  border-color: var(--ring);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 35%, transparent);
}

.dolt-revision-selector-field-disabled {
  opacity: 0.55;
}

.dolt-revision-selector-input {
  width: 100%;
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  padding: 0 2px 0 7px;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--foreground);
}

.dolt-revision-selector-input::placeholder {
  color: var(--muted-foreground);
}

.dolt-revision-selector-toggle {
  display: inline-flex;
  width: 25px;
  height: 100%;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
}

.dolt-revision-selector-toggle:hover:not(:disabled) {
  color: var(--foreground);
}

.dolt-revision-selector-options {
  position: absolute;
  z-index: 60;
  top: calc(100% + 4px);
  left: 0;
  width: max(100%, 180px);
  max-width: 280px;
  max-height: 240px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.14);
}

.dolt-revision-selector-option {
  display: flex;
  width: 100%;
  height: 26px;
  align-items: center;
  gap: 6px;
  border-radius: 3px;
  padding: 0 6px;
  text-align: left;
}

.dolt-revision-selector-option:hover,
.dolt-revision-selector-option-highlighted {
  background: var(--accent);
  color: var(--accent-foreground);
}
</style>
