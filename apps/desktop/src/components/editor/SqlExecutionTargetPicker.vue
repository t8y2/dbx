<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  candidates: SqlExecutionCandidate[];
  activeIndex: number;
  anchor?: { left: number; top: number };
}>();

const emit = defineEmits<{
  "update:activeIndex": [index: number];
  confirm: [candidate: SqlExecutionCandidate];
  cancel: [];
}>();

const { t } = useI18n();

const listboxRef = ref<HTMLDivElement>();
const optionRefs = ref<HTMLElement[]>([]);

const title = computed(() => t("editor.executionPicker.title"));
const pickerStyle = computed(() => {
  if (!props.anchor) return undefined;
  return {
    left: `${props.anchor.left}px`,
    top: `${props.anchor.top}px`,
    transform: "translate(-50%, 0)",
  };
});

function displayLabel(candidate: SqlExecutionCandidate) {
  return t(`editor.executionPicker.${candidate.label}`);
}

function optionId(index: number) {
  return `dbx-exec-target-${index}`;
}

watch(
  () => props.activeIndex,
  (index) => {
    void nextTick(() => {
      optionRefs.value[index]?.scrollIntoView({ block: "nearest" });
    });
  },
);

function setActiveIndex(index: number) {
  emit("update:activeIndex", Math.max(0, Math.min(index, props.candidates.length - 1)));
}

function confirmCurrent() {
  const candidate = props.candidates[props.activeIndex];
  if (candidate) emit("confirm", candidate);
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      setActiveIndex(props.activeIndex + 1);
      break;
    case "ArrowUp":
      event.preventDefault();
      setActiveIndex(props.activeIndex - 1);
      break;
    case "Enter":
      event.preventDefault();
      confirmCurrent();
      break;
    case "Escape":
      event.preventDefault();
      emit("cancel");
      break;
  }
}

function setOptionRef(index: number, el: Element | null) {
  if (el instanceof HTMLElement) optionRefs.value[index] = el;
}

onMounted(() => {
  listboxRef.value?.focus();
});

onBeforeUnmount(() => {
  emit("cancel");
});
</script>

<template>
  <div ref="listboxRef" role="listbox" tabindex="-1" class="sql-execution-picker absolute z-[9998] w-[520px] max-w-[calc(100vw-32px)] flex flex-col rounded-md border bg-popover shadow-lg outline-none" :style="pickerStyle" @keydown="onKeydown" @blur="emit('cancel')">
    <div class="border-b bg-muted/40 px-3 py-2">
      <div class="text-xs font-semibold">{{ title }}</div>
    </div>
    <div class="flex flex-col py-1">
      <div
        v-for="(candidate, index) in candidates"
        :id="optionId(index)"
        :key="candidate.kind"
        role="option"
        :ref="(el: any) => setOptionRef(index, el as Element | null)"
        :aria-selected="index === activeIndex"
        class="flex items-center gap-2 mx-1 px-2 py-1.5 rounded text-sm cursor-pointer select-none"
        :class="index === activeIndex ? 'bg-primary text-primary-foreground' : 'hover:bg-accent hover:text-accent-foreground'"
        @mousemove="setActiveIndex(index)"
        @click="emit('confirm', candidate)"
      >
        <span class="shrink-0 text-xs font-medium px-1.5 py-0.5 rounded border" :class="index === activeIndex ? 'border-primary-foreground/40 bg-primary-foreground/10' : 'border-border bg-muted/50'">
          {{ displayLabel(candidate) }}
        </span>
        <span class="truncate min-w-0 font-mono text-xs opacity-80">{{ candidate.sql }}</span>
      </div>
    </div>
  </div>
</template>
