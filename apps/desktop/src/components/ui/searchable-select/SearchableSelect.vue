<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { Check, ChevronDown, Search, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { ButtonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionHelpPanel } from "@/components/ui/option-help-panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterDatabaseOptions } from "@/lib/database/databaseOptionSearch";
import { cn } from "@/lib/common/utils";
import { optionHelpPanelOffsetTop } from "@/lib/common/optionHelpPanelOffset";
import { SEARCHABLE_SELECT_HELP_PANEL_ALIGN, searchableSelectKeyboardTooltipOption, searchableSelectSelectedOrFirstHelpOption } from "@/lib/common/searchableSelectTooltip";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    loadingText?: string;
    loading?: boolean;
    disabled?: boolean;
    allowCustom?: boolean;
    triggerVariant?: ButtonVariants["variant"];
    triggerClass?: HTMLAttributes["class"];
    triggerIconClass?: HTMLAttributes["class"];
    contentClass?: HTMLAttributes["class"];
    listClass?: HTMLAttributes["class"];
    itemClass?: HTMLAttributes["class"];
    displayName?: (option: string) => string;
    optionTooltip?: (option: string) => string | undefined;
    normalizeCustom?: (value: string) => string;
    clearable?: boolean;
    clearSelectedOption?: boolean;
  }>(),
  {
    loading: false,
    disabled: false,
    allowCustom: false,
    clearable: false,
    clearSelectedOption: false,
    loadingText: "Loading...",
    triggerVariant: "ghost",
    triggerIconClass: "h-3 w-3",
    displayName: (option: string) => option,
    optionTooltip: () => undefined,
    normalizeCustom: (value: string) => value,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:open": [value: boolean];
}>();

defineSlots<{
  "trigger-label"?(props: { value: string; label: string; loading: boolean }): any;
  "option-label"?(props: { option: string; label: string }): any;
  "custom-option-label"?(props: { value: string }): any;
}>();

const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();
const listContainer = ref<HTMLDivElement>();
const listCard = ref<HTMLElement>();
const helpPanel = ref<{ element?: HTMLElement }>();
const highlightIndex = ref(-1);
const activeHelpOption = ref<string>();
const helpPanelOffsetTop = ref(0);

const selectedLabel = computed(() => {
  if (!props.modelValue && !props.options.includes("")) return props.placeholder;
  return props.displayName(props.modelValue);
});

const triggerBaseClass = computed(() =>
  props.triggerVariant === "outline"
    ? "dbx-searchable-select-trigger h-6 w-auto max-w-56 min-w-0 justify-between gap-1 px-2 text-xs font-normal shadow-none"
    : "h-6 w-auto max-w-56 min-w-0 justify-between gap-1 border-0 bg-transparent px-1 text-xs font-normal shadow-none hover:bg-muted/50 focus-visible:ring-0",
);

const filteredOptions = computed(() => filterDatabaseOptions(props.options, searchText.value, props.displayName));
const customOptionValue = computed(() => props.normalizeCustom(searchText.value.trim()));
const canSelectCustom = computed(() => props.allowCustom && !!customOptionValue.value && !props.options.includes(customOptionValue.value));

function highlightSelectedOption() {
  const selectedIndex = filteredOptions.value.findIndex((option) => option === props.modelValue);
  highlightIndex.value = selectedIndex >= 0 ? selectedIndex : 0;
}

async function scrollHighlightedOptionIntoView() {
  await nextTick();
  const container = listContainer.value;
  if (!container || highlightIndex.value < 0) return;
  const buttons = container.querySelectorAll("button");
  const target = buttons[highlightIndex.value];
  target?.scrollIntoView({ block: "nearest" });
  void updateHelpPanelOffset();
}

function highlightAndScrollSelectedOption() {
  highlightSelectedOption();
  void scrollHighlightedOptionIntoView();
}

function activateInitialHelpOption() {
  activeHelpOption.value = searchableSelectSelectedOrFirstHelpOption(filteredOptions.value, props.modelValue, props.optionTooltip);
}

watch(open, async (value) => {
  emit("update:open", value);
  if (!value) {
    searchText.value = "";
    highlightIndex.value = -1;
    activeHelpOption.value = undefined;
    return;
  }
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  highlightAndScrollSelectedOption();
  activateInitialHelpOption();
});

watch(searchText, () => {
  highlightIndex.value = 0;
  activeHelpOption.value = searchableSelectKeyboardTooltipOption(filteredOptions.value, 0, props.optionTooltip);
});

watch(
  () => [props.modelValue, props.options],
  () => {
    if (!open.value || searchText.value) return;
    activeHelpOption.value = undefined;
    highlightAndScrollSelectedOption();
    activateInitialHelpOption();
  },
  { deep: true },
);

watch([highlightIndex, filteredOptions], () => {
  void scrollHighlightedOptionIntoView();
});

const activeHelpContent = computed(() => (activeHelpOption.value ? props.optionTooltip(activeHelpOption.value) : undefined));

function activateHelpForHighlightedOption() {
  activeHelpOption.value = searchableSelectKeyboardTooltipOption(filteredOptions.value, highlightIndex.value, props.optionTooltip);
}

function activateHelpForOption(option: string) {
  activeHelpOption.value = props.optionTooltip(option) ? option : undefined;
}

async function updateHelpPanelOffset() {
  if (!activeHelpOption.value) {
    helpPanelOffsetTop.value = 0;
    return;
  }
  await nextTick();
  const card = listCard.value;
  const panel = helpPanel.value?.element;
  const optionIndex = filteredOptions.value.indexOf(activeHelpOption.value);
  const option = optionIndex >= 0 ? listContainer.value?.querySelectorAll("button")[optionIndex] : undefined;
  if (!card || !panel || !option) {
    helpPanelOffsetTop.value = 0;
    return;
  }
  helpPanelOffsetTop.value = optionHelpPanelOffsetTop({
    activeItemTop: option.getBoundingClientRect().top - card.getBoundingClientRect().top,
    listCardHeight: card.clientHeight,
    panelHeight: panel.clientHeight,
  });
}

watch([activeHelpOption, filteredOptions], () => {
  void updateHelpPanelOffset();
});

function selectOption(option: string) {
  emit("update:modelValue", option);
  open.value = false;
}

function selectOrClearOption(option: string) {
  selectOption(props.clearSelectedOption && option === props.modelValue ? "" : option);
}

function selectCustomOption() {
  if (!canSelectCustom.value) return;
  selectOption(customOptionValue.value);
}

function optionTitle(option: string) {
  const label = props.displayName(option);
  return label === option ? option : `${label}\n${option}`;
}

function optionCount() {
  return filteredOptions.value.length + (canSelectCustom.value ? 1 : 0);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const total = optionCount();
    if (total === 0) return;
    highlightIndex.value = highlightIndex.value < total - 1 ? highlightIndex.value + 1 : 0;
    activateHelpForHighlightedOption();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const total = optionCount();
    if (total === 0) return;
    highlightIndex.value = highlightIndex.value > 0 ? highlightIndex.value - 1 : total - 1;
    activateHelpForHighlightedOption();
  } else if (event.key === "Enter") {
    if (highlightIndex.value < 0 || highlightIndex.value >= optionCount()) return;
    event.preventDefault();
    if (highlightIndex.value < filteredOptions.value.length) {
      selectOrClearOption(filteredOptions.value[highlightIndex.value]);
    } else {
      selectCustomOption();
    }
  } else if (event.key === "Escape") {
    open.value = false;
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button type="button" :variant="triggerVariant" :disabled="disabled" :title="selectedLabel" :class="cn(triggerBaseClass, triggerClass)">
        <slot name="trigger-label" :value="modelValue" :label="selectedLabel" :loading="loading">
          <span class="truncate">{{ loading ? loadingText : selectedLabel }}</span>
        </slot>
        <X v-if="clearable && !disabled && modelValue" :class="cn('shrink-0 opacity-60 hover:opacity-100', triggerIconClass)" @pointerdown.stop.prevent="emit('update:modelValue', '')" />
        <ChevronDown v-else :class="cn('shrink-0 opacity-60', triggerIconClass)" />
      </Button>
    </PopoverTrigger>
    <PopoverContent :align="SEARCHABLE_SELECT_HELP_PANEL_ALIGN" :class="cn('w-auto max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none ring-0', contentClass)">
      <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
        <div ref="listCard" :class="cn('shrink-0 rounded-md border bg-popover p-1.5 shadow-md', listClass)">
          <div class="relative rounded-md border bg-background">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <span v-if="!searchText" class="pointer-events-none absolute left-[25px] top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{{ searchPlaceholder }}</span>
            <Input ref="searchInput" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-sm caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown="handleKeydown" />
          </div>
          <div ref="listContainer" class="dbx-searchable-select-list max-h-64 overflow-y-auto py-1" @scroll="updateHelpPanelOffset">
            <div v-if="loading" class="px-2 py-2 text-sm text-muted-foreground">
              {{ loadingText }}
            </div>
            <template v-else-if="filteredOptions.length">
              <button
                v-for="(option, index) in filteredOptions"
                :key="option"
                type="button"
                :title="optionTooltip(option) ? undefined : optionTitle(option)"
                :class="
                  cn(
                    'group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                    props.itemClass,
                    index === highlightIndex && 'bg-accent text-accent-foreground',
                  )
                "
                @pointerenter="activateHelpForOption(option)"
                @click="selectOrClearOption(option)"
              >
                <span class="relative h-3.5 w-3.5 shrink-0">
                  <Check :class="cn('absolute inset-0 h-3.5 w-3.5', option !== modelValue ? 'opacity-0' : clearSelectedOption ? 'opacity-100 group-hover:opacity-0 group-focus-visible:opacity-0' : 'opacity-100')" />
                  <X v-if="clearSelectedOption && option === modelValue" class="absolute inset-0 h-3.5 w-3.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                </span>
                <!-- Keep custom labels inside the flex row so long content cannot overlap adjacent UI. -->
                <div class="dbx-searchable-select-option-label min-w-0 flex-1 overflow-hidden">
                  <slot name="option-label" :option="option" :label="displayName?.(option)">
                    <span class="block truncate">{{ displayName?.(option) }}</span>
                  </slot>
                </div>
              </button>
              <button
                v-if="canSelectCustom"
                type="button"
                :title="customOptionValue"
                :class="
                  cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                    props.itemClass,
                    filteredOptions.length === highlightIndex && 'bg-accent text-accent-foreground',
                  )
                "
                @pointerenter="activateHelpForOption(customOptionValue)"
                @click="selectCustomOption"
              >
                <Check class="h-3.5 w-3.5 shrink-0 opacity-0" />
                <div class="dbx-searchable-select-option-label min-w-0 flex-1 overflow-hidden">
                  <slot name="custom-option-label" :value="customOptionValue">
                    <span class="block truncate">{{ customOptionValue }}</span>
                  </slot>
                </div>
              </button>
            </template>
            <button
              v-else-if="canSelectCustom"
              type="button"
              :title="customOptionValue"
              :class="
                cn(
                  'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                  props.itemClass,
                  0 === highlightIndex && 'bg-accent text-accent-foreground',
                )
              "
              @pointerenter="activateHelpForOption(customOptionValue)"
              @click="selectCustomOption"
            >
              <Check class="h-3.5 w-3.5 shrink-0 opacity-0" />
              <div class="dbx-searchable-select-option-label min-w-0 flex-1 overflow-hidden">
                <slot name="custom-option-label" :value="customOptionValue">
                  <span class="block truncate">{{ customOptionValue }}</span>
                </slot>
              </div>
            </button>
            <div v-else class="px-2 py-2 text-sm text-muted-foreground">
              {{ emptyText }}
            </div>
          </div>
        </div>
        <OptionHelpPanel v-if="activeHelpContent" ref="helpPanel" :content="activeHelpContent" :offset-top="helpPanelOffsetTop" />
      </div>
    </PopoverContent>
  </Popover>
</template>

<style>
.dbx-searchable-select-trigger {
  border: 1px solid rgb(229, 229, 229) !important;
  background-color: rgb(255, 255, 255) !important;
  box-shadow: none !important;
}

.dbx-searchable-select-trigger:hover {
  background-color: rgb(250, 250, 250) !important;
}

.dbx-searchable-select-trigger[aria-expanded="true"],
.dbx-searchable-select-trigger:focus-visible {
  border-color: rgb(96, 165, 250) !important;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.22) !important;
}

.dark .dbx-searchable-select-trigger {
  border-color: rgba(255, 255, 255, 0.14) !important;
  background-color: rgba(255, 255, 255, 0.08) !important;
}

.dark .dbx-searchable-select-trigger:hover {
  background-color: rgba(255, 255, 255, 0.12) !important;
}

.dark .dbx-searchable-select-trigger[aria-expanded="true"],
.dark .dbx-searchable-select-trigger:focus-visible {
  border-color: rgb(147, 197, 253) !important;
  box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.24) !important;
}

.dbx-searchable-select-list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--foreground) 30%, transparent) transparent;
}

.dbx-searchable-select-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.dbx-searchable-select-list::-webkit-scrollbar-track {
  background: transparent;
}

.dbx-searchable-select-list::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  background-clip: padding-box;
}

.dbx-searchable-select-list:hover::-webkit-scrollbar-thumb {
  border: 0;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}

.dark .dbx-searchable-select-list {
  scrollbar-color: rgb(82, 82, 91) transparent;
}

.dark .dbx-searchable-select-list::-webkit-scrollbar-thumb {
  background: rgb(82, 82, 91);
  background-clip: padding-box;
}

.dark .dbx-searchable-select-list:hover::-webkit-scrollbar-thumb {
  background: rgb(113, 113, 122);
}
</style>
