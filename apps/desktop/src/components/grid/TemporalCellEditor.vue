<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { FocusOutsideEvent, PointerDownOutsideEvent } from "reka-ui";
import { CalendarClock, ChevronDown, ChevronUp, CircleSlash } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTemporalInputValue, parseTemporalInputValue, stepTemporalInputValue, type TemporalCellEditorKind } from "@/lib/dataGrid/dataGridTemporalEditor";

const props = withDefaults(
  defineProps<{
    kind: TemporalCellEditorKind;
    modelValue: string;
    variant?: "cell" | "inline";
    cellLayout?: "grid" | "transpose";
    commitOnClose?: boolean;
    fractionPrecision?: number;
  }>(),
  {
    variant: "cell",
    cellLayout: "grid",
    commitOnClose: true,
    fractionPrecision: 0,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  commit: [];
  cancel: [];
}>();

const open = ref(false);
const editorRootRef = ref<HTMLDivElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const localValue = ref(props.modelValue);
let closeHandled = false;
let isCommitting = false;
let skipCommitOnClose = false;

const hasDate = computed(() => props.kind !== "time");
const hasTime = computed(() => props.kind !== "date");
const normalizedFractionPrecision = computed(() => Math.max(0, Math.min(9, props.fractionPrecision || 0)));
const existingFractionDigits = computed(() => parseFractionDigits(timeValue.value));
const fractionInputLength = computed(() => normalizedFractionPrecision.value || existingFractionDigits.value.length);
const fractionInputMaxLength = computed(() => Math.max(1, fractionInputLength.value));
const showFractionInput = computed(() => hasTime.value && (normalizedFractionPrecision.value > 0 || existingFractionDigits.value.length > 0));
const timeGridStyle = computed(() => ({
  gridTemplateColumns: showFractionInput.value ? "3.5rem 0.5rem 3.5rem 0.5rem 3.5rem 0.5rem 5rem" : "3.5rem 0.5rem 3.5rem 0.5rem 3.5rem",
}));
const editorRootClass = computed(() => (props.variant === "inline" ? "relative h-9 w-full" : "absolute inset-0 z-10"));
const inputClass = computed(() =>
  props.variant === "inline"
    ? "cell-edit-input h-9 w-full rounded border bg-background py-0 pl-2 pr-8 text-left text-xs outline-none hover:border-primary/60 focus:border-primary"
    : ["cell-edit-input absolute inset-0 z-10 border-2 border-primary bg-background py-0 text-left text-xs outline-none", props.cellLayout === "transpose" ? "pl-1.5 pr-6" : "pl-2.5 pr-7"],
);
const triggerButtonClass = computed(() =>
  props.variant === "inline"
    ? "absolute right-1 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    : "absolute right-0.5 top-1/2 z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
);
const dateParts = computed(() => {
  const text = formatTemporalInputValue(localValue.value, "date");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
});

const timeValue = computed(() => {
  if (props.kind === "time") return formatTemporalInputValue(localValue.value, "time") || "00:00:00";
  return formatTemporalInputValue(localValue.value, "datetime").split("T")[1] || "00:00:00";
});

const timeParts = computed(() => {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/.exec(timeValue.value);
  if (!match) return { hour: "00", minute: "00", second: "00" };
  const [, hour = "00", minute = "00", second = "00"] = match;
  return { hour, minute, second };
});

onMounted(() => {
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
});

watch(
  () => props.modelValue,
  (value) => {
    localValue.value = value;
  },
);

function setOpen(value: boolean) {
  open.value = value;
  if (!value && props.commitOnClose && !closeHandled && !skipCommitOnClose) finishCommit();
}

function setModelValue(value: string) {
  localValue.value = value;
  emit("update:modelValue", value);
}

function updateTextInput(event: Event) {
  setModelValue((event.target as HTMLInputElement).value);
}

function updateDate(part: "day" | "month" | "year", rawValue: string | number) {
  const numberValue = Number(rawValue);
  const next = { ...dateParts.value };
  if (Number.isNaN(numberValue)) return;
  if (part === "year") next.year = Math.max(1, Math.min(9999, numberValue));
  else if (part === "month") next.month = Math.max(1, Math.min(12, numberValue));
  else next.day = Math.max(1, Math.min(31, numberValue));
  const maxDay = daysInMonth(next.year, next.month);
  next.day = Math.max(1, Math.min(maxDay, next.day));
  setDateTimeValue(next.year, next.month, next.day, timeValue.value);
}

function updateDateFromInput(part: "day" | "month" | "year", event: Event) {
  updateDate(part, (event.target as HTMLInputElement).value);
}

function stepDate(part: "day" | "month" | "year", delta: number) {
  setModelValue(stepTemporalInputValue(localValue.value, props.kind, part, delta));
}

function updateTime(part: "hour" | "minute" | "second", rawValue: string | number) {
  const parts = { ...timeParts.value, [part]: normalizeTimePart(rawValue, part === "hour" ? 23 : 59) };
  const nextTime = `${parts.hour}:${parts.minute}:${parts.second}${fractionSuffix.value}`;
  if (props.kind === "time") {
    setModelValue(nextTime);
    return;
  }
  setDateTimeValue(dateParts.value.year, dateParts.value.month, dateParts.value.day, nextTime);
}

function updateTimeFromInput(part: "hour" | "minute" | "second", event: Event) {
  updateTime(part, (event.target as HTMLInputElement).value);
}

function stepTime(part: "hour" | "minute" | "second", delta: number) {
  setModelValue(stepTemporalInputValue(localValue.value, props.kind, part, delta));
}

const fractionSuffix = computed(() => {
  const digits = existingFractionDigits.value;
  return digits ? `.${digits}` : "";
});

function updateFraction(event: Event) {
  updateFractionValue((event.target as HTMLInputElement).value);
}

function updateFractionValue(rawValue: string) {
  const maxLength = Math.max(1, fractionInputLength.value);
  const digits = rawValue.replace(/\D/g, "").slice(0, maxLength);
  const nextTime = `${timeParts.value.hour}:${timeParts.value.minute}:${timeParts.value.second}${digits ? `.${digits}` : ""}`;
  if (props.kind === "time") {
    setModelValue(nextTime);
    return;
  }
  setDateTimeValue(dateParts.value.year, dateParts.value.month, dateParts.value.day, nextTime);
}

function flushInputValue(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement)) return;
  const part = target.dataset.temporalPart;
  if (part === "year" || part === "month" || part === "day") {
    updateDate(part, target.value);
  } else if (part === "hour" || part === "minute" || part === "second") {
    updateTime(part, target.value);
  } else if (part === "fraction") {
    updateFractionValue(target.value);
  }
}

function normalizeTextInputValue() {
  setModelValue(parseTemporalInputValue(localValue.value, props.kind) ?? "");
}

function setNull() {
  setModelValue("NULL");
}

function setNow() {
  const now = new Date();
  const dateText = [String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const nextTime = [String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0"), String(now.getSeconds()).padStart(2, "0")].join(":") + nowFractionSuffix(now);
  if (props.kind === "date") setModelValue(dateText);
  else if (props.kind === "time") setModelValue(nextTime);
  else setModelValue(`${dateText} ${nextTime}`);
}

function finishCommit() {
  if (isCommitting) return;
  normalizeTextInputValue();
  closeHandled = true;
  isCommitting = true;
  emit("commit");
}

function finishCancel() {
  if (isCommitting) return;
  closeHandled = true;
  isCommitting = true;
  emit("cancel");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    flushInputValue(event.target);
    finishCommit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishCancel();
  }
}

function onInputBlur() {
  if (!props.commitOnClose || open.value || closeHandled || skipCommitOnClose) return;
  finishCommit();
}

function onPopoverInteractOutside(event: PointerDownOutsideEvent | FocusOutsideEvent) {
  const originalEvent = event.detail.originalEvent;
  if (isEditorInteractionTarget(originalEvent.target)) {
    event.preventDefault();
    closePickerOnly();
    return;
  }
  if (isSelectInteractionTarget(originalEvent.target)) {
    event.preventDefault();
  }
}

function closePickerOnly() {
  if (!open.value) return;
  skipCommitOnClose = true;
  setOpen(false);
  nextTick(() => {
    skipCommitOnClose = false;
  });
}

function isEditorInteractionTarget(target: EventTarget | null): boolean {
  return target instanceof Node && !!editorRootRef.value?.contains(target);
}

function isSelectInteractionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-slot='select-content'], [data-slot='select-trigger']");
}

function normalizeTimePart(value: string | number, max: number): string {
  const parsed = Number(value);
  const numberValue = Math.max(0, Math.min(max, Number.isNaN(parsed) ? 0 : parsed));
  return String(numberValue).padStart(2, "0");
}

function setDateTimeValue(year: number, month: number, day: number, time: string) {
  const dateText = [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
  if (props.kind === "date") setModelValue(dateText);
  else setModelValue(`${dateText} ${time}`);
}

function parseFractionDigits(value: string): string {
  return value.match(/\.(\d{1,9})/)?.[1] ?? "";
}

function nowFractionSuffix(now: Date): string {
  const precision = normalizedFractionPrecision.value;
  if (precision <= 0) return "";
  return `.${String(now.getMilliseconds()).padStart(3, "0").padEnd(precision, "0").slice(0, precision)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function twoDigit(value: string | number): string {
  return String(value).padStart(2, "0");
}
</script>

<template>
  <Popover :open="open" :modal="false" @update:open="setOpen">
    <div ref="editorRootRef" :class="editorRootClass" @click.stop>
      <PopoverAnchor as-child>
        <input ref="inputRef" :value="localValue" :class="inputClass" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" placeholder="NULL" @blur="onInputBlur" @click.stop @input="updateTextInput" @keydown.stop="onKeydown" />
      </PopoverAnchor>
      <PopoverTrigger as-child>
        <button type="button" :class="triggerButtonClass" @mousedown.prevent @click.stop>
          <CalendarClock class="h-3.5 w-3.5" />
          <span class="sr-only">Open temporal picker</span>
        </button>
      </PopoverTrigger>
    </div>
    <PopoverContent align="start" side="bottom" class="w-auto gap-1.5 rounded-md p-1.5" @click.stop @keydown.stop="onKeydown" @open-auto-focus.prevent @close-auto-focus.prevent @interact-outside="onPopoverInteractOutside">
      <div v-if="hasDate" class="grid grid-cols-[4.5rem_4.5rem_4.5rem] gap-1.5">
        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="dateParts.year" data-temporal-part="year" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateDateFromInput('year', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepDate('year', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepDate('year', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>

        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="twoDigit(dateParts.month)" data-temporal-part="month" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateDateFromInput('month', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepDate('month', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepDate('month', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>

        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="twoDigit(dateParts.day)" data-temporal-part="day" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateDateFromInput('day', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepDate('day', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepDate('day', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="hasTime" class="grid items-center gap-1.5" :style="timeGridStyle">
        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="twoDigit(timeParts.hour)" data-temporal-part="hour" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateTimeFromInput('hour', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepTime('hour', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepTime('hour', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>
        <span class="text-center text-xs text-muted-foreground">:</span>
        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="twoDigit(timeParts.minute)" data-temporal-part="minute" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateTimeFromInput('minute', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepTime('minute', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepTime('minute', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>
        <span class="text-center text-xs text-muted-foreground">:</span>
        <div class="grid h-7 min-w-0 grid-cols-[1fr_1.35rem] overflow-hidden rounded-md border border-input bg-background">
          <input :value="twoDigit(timeParts.second)" data-temporal-part="second" inputmode="numeric" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" @input="updateTimeFromInput('second', $event)" />
          <div class="grid border-l">
            <button type="button" class="flex items-center justify-center hover:bg-muted" @mousedown.prevent @click="stepTime('second', 1)">
              <ChevronUp class="h-3 w-3" />
            </button>
            <button type="button" class="flex items-center justify-center border-t hover:bg-muted" @mousedown.prevent @click="stepTime('second', -1)">
              <ChevronDown class="h-3 w-3" />
            </button>
          </div>
        </div>
        <template v-if="showFractionInput">
          <span class="text-center text-xs text-muted-foreground">.</span>
          <div class="grid h-7 min-w-0 overflow-hidden rounded-md border border-input bg-background">
            <input :value="existingFractionDigits" data-temporal-part="fraction" inputmode="numeric" :maxlength="fractionInputMaxLength" class="min-w-0 bg-transparent px-1 text-center text-[13px] tabular-nums outline-none" placeholder="0" @input="updateFraction" />
          </div>
        </template>
      </div>

      <div class="flex items-center justify-between gap-1">
        <Button type="button" variant="ghost" size="xs" class="h-6 px-1.5 text-[11px]" @mousedown.prevent @click="setNull">
          <CircleSlash class="h-3 w-3" />
          NULL
        </Button>
        <Button type="button" variant="ghost" size="xs" class="h-6 px-1.5 text-[11px]" @mousedown.prevent @click="setNow">Now</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
