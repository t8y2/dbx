<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { FocusOutsideEvent, PointerDownOutsideEvent } from "reka-ui";
import { CalendarClock, ChevronDown, ChevronUp, CircleSlash } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTemporalInputValue, stepTemporalInputValue, type TemporalCellEditorKind } from "@/lib/dataGridTemporalEditor";

const props = withDefaults(
  defineProps<{
    kind: TemporalCellEditorKind;
    modelValue: string;
    variant?: "cell" | "inline";
    cellLayout?: "grid" | "transpose";
    commitOnClose?: boolean;
  }>(),
  {
    variant: "cell",
    cellLayout: "grid",
    commitOnClose: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  commit: [];
  cancel: [];
}>();

const open = ref(true);
const triggerRef = ref<HTMLButtonElement | null>(null);
const localValue = ref(props.modelValue);
let closeHandled = false;
let isCommitting = false;

const hasDate = computed(() => props.kind !== "time");
const hasTime = computed(() => props.kind !== "date");
const displayValue = computed(() => localValue.value || "NULL");
const triggerClass = computed(() =>
  props.variant === "inline"
    ? "cell-edit-input flex h-9 w-full items-center gap-2 rounded border bg-background px-2 text-left text-xs outline-none hover:border-primary/60 focus:border-primary"
    : ["cell-edit-input absolute inset-0 z-10 flex items-center gap-1 border-2 border-primary bg-background py-0 text-left text-xs outline-none", props.cellLayout === "transpose" ? "px-1.5" : "px-2.5"],
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
  const [hour = "00", minute = "00", second = "00"] = timeValue.value.split(":");
  return { hour, minute, second };
});

onMounted(() => {
  nextTick(() => triggerRef.value?.focus());
});

watch(
  () => props.modelValue,
  (value) => {
    localValue.value = value;
  },
);

function setOpen(value: boolean) {
  open.value = value;
  if (!value && props.commitOnClose && !closeHandled) finishCommit();
}

function setModelValue(value: string) {
  localValue.value = value;
  emit("update:modelValue", value);
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
  const nextTime = `${parts.hour}:${parts.minute}:${parts.second}`;
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

function flushInputValue(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement)) return;
  const part = target.dataset.temporalPart;
  if (part === "year" || part === "month" || part === "day") {
    updateDate(part, target.value);
  } else if (part === "hour" || part === "minute" || part === "second") {
    updateTime(part, target.value);
  }
}

function setNull() {
  setModelValue("NULL");
}

function setNow() {
  const now = new Date();
  const dateText = [String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const nextTime = [String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0"), String(now.getSeconds()).padStart(2, "0")].join(":");
  if (props.kind === "date") setModelValue(dateText);
  else if (props.kind === "time") setModelValue(nextTime);
  else setModelValue(`${dateText} ${nextTime}`);
}

function finishCommit() {
  if (isCommitting) return;
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

function onPopoverInteractOutside(event: PointerDownOutsideEvent | FocusOutsideEvent) {
  const originalEvent = event.detail.originalEvent;
  if (originalEvent instanceof FocusEvent || isSelectInteractionTarget(originalEvent.target)) {
    event.preventDefault();
  }
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

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function twoDigit(value: string | number): string {
  return String(value).padStart(2, "0");
}
</script>

<template>
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <button ref="triggerRef" type="button" :class="triggerClass" @keydown.stop="onKeydown" @click.stop>
        <CalendarClock class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ displayValue }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" class="w-auto gap-1.5 rounded-md p-1.5" @click.stop @keydown.stop="onKeydown" @interact-outside="onPopoverInteractOutside">
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

      <div v-if="hasTime" class="grid grid-cols-[3.5rem_0.5rem_3.5rem_0.5rem_3.5rem] items-center gap-1.5">
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
