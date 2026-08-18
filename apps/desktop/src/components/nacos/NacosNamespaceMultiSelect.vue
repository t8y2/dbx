<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, ChevronDown, Loader2, Search, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { nacosNamespaceIdentity, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import type { NacosNamespaceInfo } from "@/types/nacos";

const props = withDefaults(
  defineProps<{
    modelValue: string[];
    namespaces: NacosNamespaceInfo[];
    loading?: boolean;
    error?: string;
    disabled?: boolean;
  }>(),
  {
    loading: false,
    error: "",
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
  retry: [];
}>();

const { t } = useI18n();
const open = ref(false);
const search = ref("");

const options = computed(() => {
  const normalized = normalizeNacosNamespacesForDisplay(props.namespaces).map((item) => ({
    value: nacosNamespaceIdentity(item.namespace),
    label: item.namespaceShowName || nacosNamespaceIdentity(item.namespace),
  }));
  const seen = new Set(normalized.map((item) => item.value));
  for (const value of props.modelValue) {
    if (!seen.has(value)) normalized.push({ value, label: value });
  }
  return normalized;
});

const optionLabels = computed(() => new Map(options.value.map((item) => [item.value, item.label])));
const selected = computed(() => new Set(props.modelValue));
const filteredOptions = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return options.value;
  return options.value.filter((item) => item.value.toLocaleLowerCase().includes(query) || item.label.toLocaleLowerCase().includes(query));
});

watch(open, (value) => {
  if (!value) search.value = "";
});

function toggle(value: string) {
  const next = new Set(props.modelValue);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  emit("update:modelValue", [...next]);
}

function remove(value: string) {
  emit(
    "update:modelValue",
    props.modelValue.filter((item) => item !== value),
  );
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        data-nacos-namespace-multiselect
        class="flex min-h-9 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-left text-sm shadow-sm outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="disabled"
      >
        <span v-if="!modelValue.length" class="min-w-0 flex-1 truncate text-muted-foreground">{{ t("nacos.namespaceSelectPlaceholder") }}</span>
        <span v-else class="flex min-w-0 flex-1 flex-wrap gap-1">
          <span v-for="value in modelValue" :key="value" class="inline-flex max-w-full items-center gap-1 rounded border bg-muted/60 px-1.5 py-0.5 text-xs">
            <span class="truncate">{{ optionLabels.get(value) || value }}</span>
            <span
              role="button"
              tabindex="0"
              class="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
              :aria-label="t('nacos.namespaceRemoveSelection', { namespace: optionLabels.get(value) || value })"
              @click.stop="remove(value)"
              @keydown.enter.stop.prevent="remove(value)"
              @keydown.space.stop.prevent="remove(value)"
            >
              <X class="h-3 w-3" />
            </span>
          </span>
        </span>
        <Loader2 v-if="loading" class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        <ChevronDown v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" class="z-[80] w-[var(--reka-popover-trigger-width)] gap-1 p-1.5" @open-auto-focus.prevent>
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" class="h-8 pl-8 text-sm" :placeholder="t('nacos.namespaceSearchPlaceholder')" autofocus />
      </div>
      <div class="max-h-52 overflow-y-auto py-1">
        <div v-if="loading" class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />{{ t("nacos.loading") }}</div>
        <div v-else-if="error" class="space-y-2 px-2 py-2 text-xs text-destructive">
          <p class="break-words">{{ error }}</p>
          <button type="button" class="text-foreground underline underline-offset-2" @click="emit('retry')">{{ t("nacos.retryNamespaceList") }}</button>
        </div>
        <div v-else-if="!filteredOptions.length" class="px-2 py-3 text-xs text-muted-foreground">{{ t("nacos.noNamespacesAvailable") }}</div>
        <template v-else>
          <button v-for="option in filteredOptions" :key="option.value" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" @click="toggle(option.value)">
            <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="selected.has(option.value) ? 'border-primary bg-primary text-primary-foreground' : 'border-input'">
              <Check v-if="selected.has(option.value)" class="h-3 w-3" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
            <span v-if="option.label !== option.value" class="max-w-40 truncate text-xs text-muted-foreground">{{ option.value }}</span>
          </button>
        </template>
      </div>
      <div v-if="modelValue.length" class="border-t px-2 pt-1.5 text-[11px] text-muted-foreground">{{ t("nacos.namespaceSelectedCount", { count: modelValue.length }) }}</div>
    </PopoverContent>
  </Popover>
</template>
