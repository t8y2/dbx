import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { uuid } from "@/lib/common/utils";
import type { DataGridSortDirection } from "@/lib/dataGrid/dataGridSort";

export type DataGridStructuredSortRule = {
  id: string;
  columnName: string;
  direction: DataGridSortDirection;
  disabled?: boolean;
};

type DataGridSortBuilderCacheEntry = {
  appliedOrderBy: string;
  rules: DataGridStructuredSortRule[];
};

type UseDataGridSortBuilderOptions = {
  columns: MaybeRefOrGetter<readonly string[]>;
  cacheKey: MaybeRefOrGetter<string>;
  scopeKey: MaybeRefOrGetter<string>;
  createId?: () => string;
};

const SORT_BUILDER_CACHE_MAX_ENTRIES = 128;
const sortBuilderCache = new Map<string, DataGridSortBuilderCacheEntry>();

function cloneRules(rules: readonly DataGridStructuredSortRule[]): DataGridStructuredSortRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function normalizedOrderBy(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function combineDataGridOrderByInputs(manualOrderBy: string | undefined, structuredOrderBy: string | undefined): string | undefined {
  return [normalizedOrderBy(manualOrderBy), normalizedOrderBy(structuredOrderBy)].filter(Boolean).join(", ") || undefined;
}

export function buildDataGridStructuredOrderBy(rules: readonly DataGridStructuredSortRule[], quoteColumn: (columnName: string) => string): string | undefined {
  const activeRules = rules.filter((rule) => !rule.disabled);
  if (activeRules.some((rule) => !rule.columnName)) return undefined;
  return activeRules.map((rule) => `${quoteColumn(rule.columnName)} ${rule.direction.toUpperCase()}`).join(", ");
}

export function moveDataGridStructuredSortRule(rules: readonly DataGridStructuredSortRule[], ruleId: string, targetIndex: number): DataGridStructuredSortRule[] {
  const sourceIndex = rules.findIndex((rule) => rule.id === ruleId);
  if (sourceIndex < 0 || rules.length < 2) return cloneRules(rules);
  const nextIndex = Math.min(rules.length - 1, Math.max(0, Math.trunc(targetIndex)));
  if (sourceIndex === nextIndex) return cloneRules(rules);
  const nextRules = cloneRules(rules);
  const [rule] = nextRules.splice(sourceIndex, 1);
  nextRules.splice(nextIndex, 0, rule!);
  return nextRules;
}

export function useDataGridSortBuilder(options: UseDataGridSortBuilderOptions) {
  const rules = ref<DataGridStructuredSortRule[]>([]);
  const open = ref(false);
  const appliedOrderByInput = ref("");
  const activeRuleCount = computed(() => rules.value.filter((rule) => !rule.disabled && !!rule.columnName).length);

  function defaultRule(): DataGridStructuredSortRule {
    return { id: options.createId?.() ?? uuid(), columnName: "", direction: "asc" };
  }

  function entryKey(): string | undefined {
    const cacheKey = toValue(options.cacheKey);
    if (!cacheKey) return undefined;
    return JSON.stringify({ cacheKey, scopeKey: toValue(options.scopeKey) });
  }

  function persist() {
    const key = entryKey();
    if (!key) return;
    sortBuilderCache.delete(key);
    sortBuilderCache.set(key, { appliedOrderBy: appliedOrderByInput.value, rules: cloneRules(rules.value) });
    while (sortBuilderCache.size > SORT_BUILDER_CACHE_MAX_ENTRIES) {
      const oldest = sortBuilderCache.keys().next().value;
      if (oldest === undefined) break;
      sortBuilderCache.delete(oldest);
    }
  }

  function restore() {
    const key = entryKey();
    const cached = key ? sortBuilderCache.get(key) : undefined;
    if (cached) {
      rules.value = cloneRules(cached.rules);
      appliedOrderByInput.value = cached.appliedOrderBy;
      if (open.value && !rules.value.length && toValue(options.columns).length) rules.value = [defaultRule()];
      return;
    }
    rules.value = open.value && toValue(options.columns).length ? [defaultRule()] : [];
    appliedOrderByInput.value = "";
    persist();
  }

  function setOpen(value: boolean) {
    if (value && !rules.value.length && toValue(options.columns).length) rules.value = [defaultRule()];
    open.value = value;
  }

  function addRule() {
    if (!toValue(options.columns).length) return;
    rules.value = [...rules.value, defaultRule()];
  }

  function removeRule(id: string) {
    rules.value = rules.value.filter((rule) => rule.id !== id);
  }

  function updateRule(id: string, patch: Partial<DataGridStructuredSortRule>) {
    rules.value = rules.value.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule));
  }

  function moveRule(id: string, targetIndex: number) {
    rules.value = moveDataGridStructuredSortRule(rules.value, id, targetIndex);
  }

  function enableOnlyRule(id: string) {
    if (!rules.value.some((rule) => rule.id === id)) return;
    rules.value = rules.value.map((rule) => ({ ...rule, disabled: rule.id !== id }));
  }

  function reset() {
    rules.value = toValue(options.columns).length ? [defaultRule()] : [];
  }

  function clear() {
    appliedOrderByInput.value = "";
    reset();
    persist();
  }

  function markApplied(orderBy: string) {
    appliedOrderByInput.value = normalizedOrderBy(orderBy);
    persist();
  }

  watch(rules, persist, { deep: true });
  watch([() => toValue(options.cacheKey), () => toValue(options.scopeKey)], restore, { immediate: true });

  return {
    rules,
    open,
    appliedOrderByInput,
    activeRuleCount,
    setOpen,
    addRule,
    removeRule,
    updateRule,
    moveRule,
    enableOnlyRule,
    reset,
    clear,
    markApplied,
    restore,
  };
}

export function clearDataGridSortBuilderMemoryCache() {
  sortBuilderCache.clear();
}
