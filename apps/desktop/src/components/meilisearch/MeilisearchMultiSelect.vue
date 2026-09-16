<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, ChevronDown, Loader2 } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    options: string[];
    placeholder: string;
    disabled?: boolean;
    loading?: boolean;
    error?: string;
  }>(),
  {
    disabled: false,
    loading: false,
    error: "",
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const open = ref(false);
const selected = computed(() => new Set(props.modelValue));
const displayValue = computed(() => props.modelValue.join(", "));

function toggle(value: string) {
  const next = new Set(props.modelValue);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  emit(
    "update:modelValue",
    props.options.filter((option) => next.has(option)),
  );
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="flex min-h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm outline-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="disabled"
      >
        <span class="min-w-0 flex-1 truncate" :class="modelValue.length ? 'font-mono text-xs' : 'text-muted-foreground'">{{ displayValue || placeholder }}</span>
        <Loader2 v-if="loading" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" class="z-[80] w-[var(--reka-popover-trigger-width)] gap-1 p-1.5" @open-auto-focus.prevent>
      <div v-if="error" class="px-2 py-2 text-xs text-destructive">{{ error }}</div>
      <div v-if="loading" class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />{{ placeholder }}</div>
      <div v-else class="max-h-60 overflow-y-auto py-0.5">
        <button v-for="option in options" :key="option" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" @click="toggle(option)">
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="selected.has(option) ? 'border-primary bg-primary text-primary-foreground' : 'border-input'">
            <Check v-if="selected.has(option)" class="h-3 w-3" />
          </span>
          <span class="min-w-0 flex-1 truncate">{{ option }}</span>
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
