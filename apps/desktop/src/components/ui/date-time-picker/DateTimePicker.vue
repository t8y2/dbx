<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, useId, watch } from "vue";
import type { CalendarDateTime } from "@internationalized/date";
import { endOfMonth, startOfMonth, startOfWeek } from "@internationalized/date";
import { CalendarClock, ChevronLeft, ChevronRight } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { calendarDateTimeFromFields, currentLocalDateTime, formatLocalDateTime, isValidLocalDateTime, parseLocalDateTime, type CalendarDateTimeLike } from "./dateTimePicker";

type TimePart = "hour" | "minute" | "second";

type DateTimePickerLabel = "open" | "inputLabel" | "inputPlaceholder" | "previousMonth" | "nextMonth" | "calendarLabel" | "timeLabel" | "hour" | "minute" | "second" | "cancel" | "apply" | "invalidDateTime" | "outOfRange";

const props = withDefaults(
  defineProps<{
    modelValue?: CalendarDateTimeLike | null;
    open?: boolean;
    defaultOpen?: boolean;
    disabled?: boolean;
    compact?: boolean;
    fullWidth?: boolean;
    locale?: string;
    min?: CalendarDateTimeLike | null;
    max?: CalendarDateTimeLike | null;
    placeholder?: string;
    labels?: Partial<Record<DateTimePickerLabel, string>>;
  }>(),
  {
    // Keep the picker uncontrolled when callers omit `open`.
    open: undefined,
    defaultOpen: false,
    disabled: false,
    compact: false,
    fullWidth: false,
    placeholder: undefined,
    labels: () => ({}),
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: CalendarDateTime];
  "update:open": [value: boolean];
  apply: [value: CalendarDateTime];
  cancel: [];
}>();

const { t, locale: appLocale } = useI18n();
const localOpen = ref(props.defaultOpen);
const inputId = useId();
const draft = shallowRef<CalendarDateTime | null>(null);
const localInputText = ref("");
const visibleMonth = shallowRef<CalendarDateTime>(currentLocalDateTime());
const calendarGridRef = ref<HTMLElement>();
const calendarFocus = shallowRef<CalendarDateTime | null>(null);
const closeReason = ref<"apply" | "cancel" | null>(null);
const timeInputs = reactive<Record<TimePart, string>>({ hour: "00", minute: "00", second: "00" });
const invalidTimeInputs = reactive<Record<TimePart, boolean>>({ hour: false, minute: false, second: false });

const isOpen = computed(() => props.open ?? localOpen.value);
const resolvedLocale = computed(() => props.locale || appLocale.value || "en");
const parsedInput = computed(() => parseLocalDateTime(localInputText.value));
const hasInvalidTimeInput = computed(() => Object.values(invalidTimeInputs).some(Boolean));
const validationMessage = computed(() => {
  if (hasInvalidTimeInput.value || !parsedInput.value) return label("invalidDateTime", "Enter a valid local date and time.");
  if (!isValidLocalDateTime(parsedInput.value)) return label("invalidDateTime", "Enter a valid local date and time.");
  if (!isWithinRange(parsedInput.value)) return label("outOfRange", "Choose a date and time within the allowed range.");
  return null;
});
const canApply = computed(() => !props.disabled && !validationMessage.value && !!parsedInput.value);
const triggerText = computed(() => (props.modelValue ? formatLocalDateTime(props.modelValue) : props.placeholder || label("inputPlaceholder", "YYYY-MM-DD HH:mm:ss")));
const monthHeading = computed(() => formatMonth(visibleMonth.value, resolvedLocale.value));
const weekDays = computed(() => calendarWeekDays(resolvedLocale.value));
const calendarWeeks = computed(() => buildCalendarWeeks(visibleMonth.value, resolvedLocale.value));
const today = computed(() => currentLocalDateTime());

watch(
  () => props.modelValue,
  () => {
    if (!isOpen.value) resetDraft();
  },
);

watch(
  () => props.open,
  (open, previous) => {
    if (open === previous) return;
    if (open) beginDraft();
    else resetDraft();
  },
);

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && isOpen.value) requestClose("cancel");
  },
);

function label(key: DateTimePickerLabel, fallback: string): string {
  const override = props.labels[key];
  if (override) return override;
  const translationKey = `dateTimePicker.${key}`;
  const translated = t(translationKey);
  return translated === translationKey ? fallback : translated;
}

function beginDraft() {
  const value = props.modelValue ? calendarDateTimeFromFields(props.modelValue) : currentLocalDateTime();
  draft.value = value;
  localInputText.value = formatLocalDateTime(value);
  visibleMonth.value = startOfMonth(value);
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value, value);
  syncTimeInputs(value);
  clearTimeInputErrors();
}

function resetDraft() {
  const value = props.modelValue ? calendarDateTimeFromFields(props.modelValue) : currentLocalDateTime();
  draft.value = value;
  localInputText.value = formatLocalDateTime(value);
  visibleMonth.value = startOfMonth(value);
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value, value);
  syncTimeInputs(value);
  clearTimeInputErrors();
}

function onPopoverOpenChange(open: boolean) {
  if (open) {
    if (props.disabled || isOpen.value) return;
    beginDraft();
    if (props.open === undefined) localOpen.value = true;
    emit("update:open", true);
    return;
  }

  if (closeReason.value) return;
  requestClose("cancel");
}

function requestClose(reason: "apply" | "cancel") {
  if (closeReason.value || !isOpen.value) return;
  closeReason.value = reason;
  if (reason === "cancel") {
    resetDraft();
    emit("cancel");
  }
  if (props.open === undefined) localOpen.value = false;
  emit("update:open", false);
  void nextTick(() => {
    closeReason.value = null;
  });
}

function applyDraft() {
  const value = parsedInput.value;
  if (!value || !canApply.value) return;
  emit("update:modelValue", value);
  emit("apply", value);
  requestClose("apply");
}

function handleEscape(event: Event) {
  event.preventDefault();
  event.stopPropagation();
  requestClose("cancel");
}

function updateTextInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  localInputText.value = value;
  const parsed = parseLocalDateTime(value);
  if (!parsed) return;
  draft.value = parsed;
  visibleMonth.value = startOfMonth(parsed);
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value, parsed);
  syncTimeInputs(parsed);
  clearTimeInputErrors();
}

function normalizeTextInput() {
  const parsed = parsedInput.value;
  if (!parsed) return;
  setDraft(parsed);
}

function selectDate(value: CalendarDateTime) {
  if (props.disabled || !isCalendarDateSelectable(value)) return;
  const base = draft.value ?? currentLocalDateTime();
  const next = base.set({ year: value.year, month: value.month, day: value.day });
  setDraft(next);
  visibleMonth.value = startOfMonth(next);
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value, next);
}

function showPreviousMonth() {
  visibleMonth.value = startOfMonth(visibleMonth.value.subtract({ months: 1 }));
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value);
}

function showNextMonth() {
  visibleMonth.value = startOfMonth(visibleMonth.value.add({ months: 1 }));
  calendarFocus.value = calendarFocusForMonth(visibleMonth.value);
}

function onCalendarDayKeydown(day: CalendarDateTime, event: KeyboardEvent) {
  const offset = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : null;
  if (offset === null) return;
  event.preventDefault();

  const next = day.add({ days: offset });
  if (!isCalendarDateSelectable(next)) return;
  selectDate(next);
  void nextTick(() => {
    const selector = `[data-date-time-picker-day="${calendarDayValue(next)}"]`;
    const button = calendarGridRef.value?.querySelector?.(selector) as HTMLButtonElement | undefined;
    button?.focus();
  });
}

function calendarFocusForMonth(month: CalendarDateTime, preferred = calendarFocus.value ?? draft.value ?? month): CalendarDateTime | null {
  const minimum = props.min ? calendarDateTimeFromFields(props.min) : null;
  const maximum = props.max ? calendarDateTimeFromFields(props.max) : null;
  const firstDay = month.set({ day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
  const lastDay = endOfMonth(month).set({ hour: 23, minute: 59, second: 59, millisecond: 0 });
  if ((minimum && lastDay.compare(minimum) < 0) || (maximum && firstDay.compare(maximum) > 0)) return null;

  const candidate = preferred.set({ year: month.year, month: month.month, day: Math.min(preferred.day, lastDay.day) });
  if (isCalendarDateSelectable(candidate)) return candidate;
  if (minimum && firstDay.compare(minimum) < 0) return minimum;
  if (maximum && lastDay.compare(maximum) > 0) return maximum;
  return null;
}

function calendarDayValue(value: CalendarDateTimeLike): string {
  return formatLocalDateTime(value).slice(0, 10);
}

function updateTimeInput(part: TimePart, event: Event) {
  const maximum = part === "hour" ? 23 : 59;
  const raw = (event.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 2);
  timeInputs[part] = raw;
  const value = Number(raw);
  invalidTimeInputs[part] = raw.length === 0 || !Number.isInteger(value) || value > maximum;
  if (invalidTimeInputs[part]) return;

  const base = draft.value ?? currentLocalDateTime();
  const next = base.set({ [part]: value });
  draft.value = next;
  localInputText.value = formatLocalDateTime(next);
}

function normalizeTimeInput(part: TimePart) {
  const value = draft.value ?? currentLocalDateTime();
  timeInputs[part] = twoDigits(value[part]);
  invalidTimeInputs[part] = false;
}

function onTimeInputKeydown(part: TimePart, event: KeyboardEvent) {
  if (event.key === "Escape") {
    handleEscape(event);
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  normalizeTimeInput(part);
}

function setDraft(value: CalendarDateTime) {
  draft.value = value;
  localInputText.value = formatLocalDateTime(value);
  syncTimeInputs(value);
  clearTimeInputErrors();
}

function syncTimeInputs(value: CalendarDateTime) {
  timeInputs.hour = twoDigits(value.hour);
  timeInputs.minute = twoDigits(value.minute);
  timeInputs.second = twoDigits(value.second);
}

function clearTimeInputErrors() {
  invalidTimeInputs.hour = false;
  invalidTimeInputs.minute = false;
  invalidTimeInputs.second = false;
}

function isWithinRange(value: CalendarDateTime): boolean {
  const minimum = props.min ? calendarDateTimeFromFields(props.min) : null;
  const maximum = props.max ? calendarDateTimeFromFields(props.max) : null;
  return (!minimum || value.compare(minimum) >= 0) && (!maximum || value.compare(maximum) <= 0);
}

function isCalendarDateSelectable(value: CalendarDateTime): boolean {
  const firstSecond = value.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  const lastSecond = value.set({ hour: 23, minute: 59, second: 59, millisecond: 0 });
  const minimum = props.min ? calendarDateTimeFromFields(props.min) : null;
  const maximum = props.max ? calendarDateTimeFromFields(props.max) : null;
  return (!minimum || lastSecond.compare(minimum) >= 0) && (!maximum || firstSecond.compare(maximum) <= 0);
}

function isSameDay(left: CalendarDateTimeLike, right: CalendarDateTimeLike | null | undefined): boolean {
  return !!right && left.year === right.year && left.month === right.month && left.day === right.day;
}

function isOutsideVisibleMonth(value: CalendarDateTime): boolean {
  return value.year !== visibleMonth.value.year || value.month !== visibleMonth.value.month;
}

function formatMonth(value: CalendarDateTime, locale: string): string {
  return new Intl.DateTimeFormat(locale, { calendar: "gregory", month: "long", year: "numeric", timeZone: "UTC" }).format(value.toDate("UTC"));
}

function calendarWeekDays(locale: string): string[] {
  const firstSunday = parseLocalDateTime("2023-01-01 00:00:00")!;
  const firstDay = startOfWeek(firstSunday, locale);
  const formatter = new Intl.DateTimeFormat(locale, { calendar: "gregory", weekday: "short", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, index) => formatter.format(firstDay.add({ days: index }).toDate("UTC")));
}

function buildCalendarWeeks(month: CalendarDateTime, locale: string): CalendarDateTime[][] {
  const firstDay = startOfWeek(startOfMonth(month), locale);
  const lastDay = endOfMonth(month);
  const numberOfWeeks = Math.ceil((daysBetween(firstDay, lastDay) + 1) / 7);
  const weeks = Math.max(4, Math.min(6, numberOfWeeks));
  return Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, day) => firstDay.add({ days: week * 7 + day })));
}

function daysBetween(first: CalendarDateTime, last: CalendarDateTime): number {
  // CalendarDateTime has no duration-between helper; dates in this picker are Gregorian.
  return Math.round((last.toDate("UTC").getTime() - first.toDate("UTC").getTime()) / 86_400_000);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

if (isOpen.value) beginDraft();
</script>

<template>
  <Popover :open="isOpen" :modal="false" @update:open="onPopoverOpenChange">
    <div data-date-time-picker class="max-w-full min-w-0" :class="fullWidth ? 'w-full' : 'inline-flex'">
      <PopoverTrigger as-child>
        <slot name="trigger" :open="isOpen" :value="modelValue ?? null">
          <button
            type="button"
            data-date-time-picker-trigger
            class="flex min-w-0 items-center gap-1.5 rounded-md border border-input bg-background text-left tabular-nums outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
            :class="[compact ? 'h-6 px-1.5 text-xs' : 'h-8 px-2.5 text-sm', fullWidth ? 'w-full' : '']"
            :disabled="disabled"
            :aria-label="label('open', 'Open date and time picker')"
          >
            <CalendarClock class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate" :class="modelValue ? 'text-foreground' : 'text-muted-foreground'">{{ triggerText }}</span>
          </button>
        </slot>
      </PopoverTrigger>
    </div>

    <PopoverContent data-date-time-picker-content align="start" side="bottom" :collision-padding="8" class="w-[19.5rem] max-h-[var(--reka-popover-content-available-height)] max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto rounded-lg p-3" @escape-key-down="handleEscape">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-foreground" :for="inputId">{{ label("inputLabel", "Local date and time") }}</label>
        <input
          :id="inputId"
          :value="localInputText"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          data-date-time-picker-input
          class="h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs tabular-nums outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
          :placeholder="label('inputPlaceholder', 'YYYY-MM-DD HH:mm:ss')"
          :disabled="disabled"
          :aria-invalid="!!validationMessage"
          :aria-describedby="validationMessage ? `${inputId}-validation` : undefined"
          @input="updateTextInput"
          @blur="normalizeTextInput"
          @keydown.enter.prevent
          @keydown.escape="handleEscape"
        />
      </div>

      <section class="space-y-2" :aria-label="label('calendarLabel', 'Calendar')">
        <div class="flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled" :aria-label="label('previousMonth', 'Previous month')" @click="showPreviousMonth">
            <ChevronLeft class="h-4 w-4" />
          </Button>
          <div class="text-sm font-medium" aria-live="polite">{{ monthHeading }}</div>
          <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled" :aria-label="label('nextMonth', 'Next month')" @click="showNextMonth">
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>

        <div ref="calendarGridRef" class="space-y-0.5 text-center text-[11px]" role="grid" :aria-label="label('calendarLabel', 'Calendar')">
          <div role="row" class="grid grid-cols-7 gap-0.5">
            <div v-for="weekDay in weekDays" :key="weekDay" role="columnheader" class="py-0.5 font-medium text-muted-foreground">{{ weekDay }}</div>
          </div>
          <div v-for="(week, weekIndex) in calendarWeeks" :key="weekIndex" role="row" class="grid grid-cols-7 gap-0.5">
            <div v-for="day in week" :key="day.toString()" role="gridcell" :aria-selected="isSameDay(day, draft)">
              <button
                type="button"
                :data-date-time-picker-day="calendarDayValue(day)"
                class="flex h-8 w-full items-center justify-center rounded-md text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60"
                :class="[isOutsideVisibleMonth(day) ? 'text-muted-foreground' : 'text-foreground', isSameDay(day, draft) ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-muted', isSameDay(day, today) && !isSameDay(day, draft) ? 'ring-1 ring-primary/50' : '']"
                :disabled="disabled || !isCalendarDateSelectable(day)"
                :tabindex="isSameDay(day, calendarFocus) ? 0 : -1"
                :aria-current="isSameDay(day, today) ? 'date' : undefined"
                :aria-label="formatLocalDateTime(day)"
                @click="selectDate(day)"
                @keydown="onCalendarDayKeydown(day, $event)"
              >
                {{ day.day }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-1.5" :aria-label="label('timeLabel', 'Time')">
        <div class="text-xs font-medium text-foreground">{{ label("timeLabel", "Time") }}</div>
        <div class="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1">
          <input
            :value="timeInputs.hour"
            type="text"
            inputmode="numeric"
            maxlength="2"
            data-date-time-picker-time-part="hour"
            class="h-8 min-w-0 rounded-md border border-input bg-background px-1 text-center font-mono text-sm tabular-nums outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 aria-invalid:border-destructive"
            :disabled="disabled"
            :aria-label="label('hour', 'Hour')"
            :aria-invalid="invalidTimeInputs.hour"
            @input="updateTimeInput('hour', $event)"
            @blur="normalizeTimeInput('hour')"
            @keydown="onTimeInputKeydown('hour', $event)"
          />
          <span class="text-muted-foreground">:</span>
          <input
            :value="timeInputs.minute"
            type="text"
            inputmode="numeric"
            maxlength="2"
            data-date-time-picker-time-part="minute"
            class="h-8 min-w-0 rounded-md border border-input bg-background px-1 text-center font-mono text-sm tabular-nums outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 aria-invalid:border-destructive"
            :disabled="disabled"
            :aria-label="label('minute', 'Minute')"
            :aria-invalid="invalidTimeInputs.minute"
            @input="updateTimeInput('minute', $event)"
            @blur="normalizeTimeInput('minute')"
            @keydown="onTimeInputKeydown('minute', $event)"
          />
          <span class="text-muted-foreground">:</span>
          <input
            :value="timeInputs.second"
            type="text"
            inputmode="numeric"
            maxlength="2"
            data-date-time-picker-time-part="second"
            class="h-8 min-w-0 rounded-md border border-input bg-background px-1 text-center font-mono text-sm tabular-nums outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 aria-invalid:border-destructive"
            :disabled="disabled"
            :aria-label="label('second', 'Second')"
            :aria-invalid="invalidTimeInputs.second"
            @input="updateTimeInput('second', $event)"
            @blur="normalizeTimeInput('second')"
            @keydown="onTimeInputKeydown('second', $event)"
          />
        </div>
      </section>

      <p v-if="validationMessage" :id="`${inputId}-validation`" class="text-xs text-destructive" role="alert">{{ validationMessage }}</p>

      <div class="flex items-center justify-end gap-2 border-t pt-2.5">
        <Button type="button" variant="outline" size="sm" :disabled="disabled" @click="requestClose('cancel')">{{ label("cancel", "Cancel") }}</Button>
        <Button type="button" size="sm" :disabled="!canApply" @click="applyDraft">{{ label("apply", "Apply") }}</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
