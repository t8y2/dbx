<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { Check, ChevronDown, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import type { ButtonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterDatabaseOptions } from "@/lib/databaseOptionSearch";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    loadingText: string;
    loading?: boolean;
    allowCustom?: boolean;
    triggerVariant?: ButtonVariants["variant"];
    triggerClass?: HTMLAttributes["class"];
    contentClass?: HTMLAttributes["class"];
    itemClass?: HTMLAttributes["class"];
    displayName?: (option: string) => string;
    normalizeCustom?: (value: string) => string;
  }>(),
  {
    loading: false,
    allowCustom: false,
    triggerVariant: "ghost",
    displayName: (option: string) => option,
    normalizeCustom: (value: string) => value,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:open": [value: boolean];
}>();

const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();
const listContainer = ref<HTMLDivElement>();
const highlightIndex = ref(-1);

const selectedLabel = computed(() => {
  if (!props.modelValue && !props.options.includes("")) return props.placeholder;
  return props.displayName(props.modelValue);
});

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
}

function highlightAndScrollSelectedOption() {
  highlightSelectedOption();
  void scrollHighlightedOptionIntoView();
}

watch(open, async (value) => {
  emit("update:open", value);
  if (!value) {
    searchText.value = "";
    highlightIndex.value = -1;
    return;
  }
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  highlightAndScrollSelectedOption();
});

watch(searchText, () => {
  highlightIndex.value = 0;
});

watch(
  () => [props.modelValue, props.options],
  () => {
    if (!open.value || searchText.value) return;
    highlightAndScrollSelectedOption();
  },
  { deep: true },
);

watch(highlightIndex, scrollHighlightedOptionIntoView);

function selectOption(option: string) {
  emit("update:modelValue", option);
  open.value = false;
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
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const total = optionCount();
    if (total === 0) return;
    highlightIndex.value = highlightIndex.value > 0 ? highlightIndex.value - 1 : total - 1;
  } else if (event.key === "Enter") {
    if (highlightIndex.value < 0 || highlightIndex.value >= optionCount()) return;
    event.preventDefault();
    if (highlightIndex.value < filteredOptions.value.length) {
      selectOption(filteredOptions.value[highlightIndex.value]);
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
      <Button type="button" :variant="triggerVariant" :title="selectedLabel" :class="cn('h-6 w-auto max-w-56 min-w-0 justify-between gap-1 border-0 bg-transparent px-1 text-xs font-normal shadow-none hover:bg-muted/50 focus-visible:ring-0', triggerClass)">
        <slot name="trigger-label" :value="modelValue" :label="selectedLabel" :loading="loading">
          <span class="truncate">{{ loading ? loadingText : selectedLabel }}</span>
        </slot>
        <ChevronDown class="h-3 w-3 shrink-0 opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" :class="cn('w-52 gap-1 p-1.5', contentClass)">
      <div class="relative rounded-sm border bg-background">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <span v-if="!searchText" class="pointer-events-none absolute left-[25px] top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{{ searchPlaceholder }}</span>
        <Input ref="searchInput" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-sm caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown="handleKeydown" />
      </div>
      <div ref="listContainer" class="max-h-64 overflow-y-auto py-1">
        <div v-if="loading" class="px-2 py-2 text-sm text-muted-foreground">
          {{ loadingText }}
        </div>
        <template v-else-if="filteredOptions.length">
          <button
            v-for="(option, index) in filteredOptions"
            :key="option"
            type="button"
            :title="optionTitle(option)"
            :class="
              cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                props.itemClass,
                index === highlightIndex && 'bg-accent text-accent-foreground',
              )
            "
            @click="selectOption(option)"
          >
            <Check :class="cn('h-3.5 w-3.5 shrink-0', option === modelValue ? 'opacity-100' : 'opacity-0')" />
            <slot name="option-label" :option="option" :label="displayName(option)">
              <span class="truncate">{{ displayName(option) }}</span>
            </slot>
          </button>
          <button
            v-if="canSelectCustom"
            type="button"
            :title="customOptionValue"
            :class="
              cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                props.itemClass,
                filteredOptions.length === highlightIndex && 'bg-accent text-accent-foreground',
              )
            "
            @click="selectCustomOption"
          >
            <Check class="h-3.5 w-3.5 shrink-0 opacity-0" />
            <slot name="custom-option-label" :value="customOptionValue">
              <span class="truncate">{{ customOptionValue }}</span>
            </slot>
          </button>
        </template>
        <button
          v-else-if="canSelectCustom"
          type="button"
          :title="customOptionValue"
          :class="
            cn(
              'flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
              props.itemClass,
              0 === highlightIndex && 'bg-accent text-accent-foreground',
            )
          "
          @click="selectCustomOption"
        >
          <Check class="h-3.5 w-3.5 shrink-0 opacity-0" />
          <slot name="custom-option-label" :value="customOptionValue">
            <span class="truncate">{{ customOptionValue }}</span>
          </slot>
        </button>
        <div v-else class="px-2 py-2 text-sm text-muted-foreground">
          {{ emptyText }}
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
