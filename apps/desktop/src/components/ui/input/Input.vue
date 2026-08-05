<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed, ref, useAttrs } from "vue";
import { Minus, Plus } from "@lucide/vue";
import { useVModel } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/common/utils";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  defaultValue?: string | number;
  modelValue?: string | number;
  class?: HTMLAttributes["class"];
  stepper?: boolean;
  increaseLabel?: string;
  decreaseLabel?: string;
}>();

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void;
}>();

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
});

const attrs = useAttrs();
const inputRef = ref<HTMLInputElement | null>(null);
const isNumberInput = computed(() => attrs.type === "number");
const isStepperEnabled = computed(() => isNumberInput.value && props.stepper === true);
const isStepperDisabled = computed(() => booleanAttrEnabled(attrs.disabled) || booleanAttrEnabled(attrs.readonly));
const { t } = useI18n();
const increaseLabel = computed(() => props.increaseLabel ?? t("common.increase"));
const decreaseLabel = computed(() => props.decreaseLabel ?? t("common.decrease"));

const baseClass =
  "dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-md border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 aria-invalid:ring-3 md:text-sm w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";
const numberInputWrapperClass = computed(() => {
  const layoutClass = layoutClassOnly(cn(props.class));
  return cn("dbx-number-input-wrapper relative min-w-0", layoutClass || "w-full");
});

function booleanAttrEnabled(value: unknown) {
  return value !== undefined && value !== null && value !== false;
}

function layoutClassOnly(className: string) {
  return className
    .split(/\s+/)
    .filter((item) => item.length > 0 && isLayoutClass(item))
    .join(" ");
}

function isLayoutClass(className: string) {
  const base = className.slice(className.lastIndexOf(":") + 1);
  return (
    /^(w|min-w|max-w)-/.test(base) ||
    /^(flex|grow|shrink|basis)-/.test(base) ||
    /^(col|row)-(span|start|end)-/.test(base) ||
    /^(self|justify-self|place-self)-/.test(base) ||
    /^order-/.test(base) ||
    /^z-/.test(base) ||
    /^(m|mx|my|ms|me|mt|mr|mb|ml)-/.test(base) ||
    /^(block|inline-block|inline-flex|inline-grid|grid|hidden|absolute|fixed|sticky|static)$/.test(base)
  );
}

function emitNativeInputEvents(input: HTMLInputElement) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fallbackStep(input: HTMLInputElement, direction: 1 | -1) {
  const stepValue = Number(input.step);
  const step = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 1;
  const currentValue = Number(input.value);
  const current = Number.isFinite(currentValue) ? currentValue : 0;
  input.value = String(current + step * direction);
}

function stepNumber(direction: 1 | -1) {
  if (isStepperDisabled.value) return;
  const input = inputRef.value;
  if (!input) return;

  try {
    if (direction > 0) input.stepUp();
    else input.stepDown();
  } catch {
    fallbackStep(input, direction);
  }

  emitNativeInputEvents(input);
  input.focus();
}
</script>

<template>
  <div v-if="isStepperEnabled" :class="numberInputWrapperClass">
    <input ref="inputRef" v-bind="attrs" v-model="modelValue" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" data-slot="input" :class="cn(baseClass, props.class, 'dbx-number-input-field pr-10')" />
    <div class="dbx-number-stepper">
      <button type="button" tabindex="-1" class="dbx-number-stepper-button" :disabled="isStepperDisabled" :aria-label="increaseLabel" :title="increaseLabel" @mousedown.prevent @click.stop="stepNumber(1)">
        <Plus class="dbx-number-stepper-icon" aria-hidden="true" />
      </button>
      <button type="button" tabindex="-1" class="dbx-number-stepper-button" :disabled="isStepperDisabled" :aria-label="decreaseLabel" :title="decreaseLabel" @mousedown.prevent @click.stop="stepNumber(-1)">
        <Minus class="dbx-number-stepper-icon" aria-hidden="true" />
      </button>
    </div>
  </div>
  <input v-else ref="inputRef" v-bind="attrs" v-model="modelValue" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" data-slot="input" :class="cn(baseClass, props.class)" />
</template>

<style scoped>
.dbx-number-input-wrapper {
  display: block;
}

.dbx-number-input-field[type="number"] {
  -moz-appearance: textfield;
  appearance: textfield;
  font-variant-numeric: tabular-nums;
}

.dbx-number-input-field[type="number"]::-webkit-inner-spin-button,
.dbx-number-input-field[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none !important;
  appearance: none !important;
  margin: 0 !important;
  display: none;
}

.dbx-number-stepper {
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  display: flex;
  width: 2rem;
  min-height: 1.25rem;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--border);
  border-radius: 0 0.25rem 0.25rem 0;
  background: var(--background);
}

.dbx-number-stepper-button {
  display: flex;
  min-height: 0;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  line-height: 1;
}

.dbx-number-stepper-button:first-child {
  border-bottom: 1px solid var(--border);
}

.dbx-number-stepper-button:hover {
  background: var(--muted);
  color: var(--foreground);
}

.dbx-number-stepper-button:active {
  background: var(--accent);
}

.dbx-number-stepper-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.dbx-number-stepper-icon {
  width: 1rem;
  height: 1rem;
  stroke-width: 3;
}
</style>
