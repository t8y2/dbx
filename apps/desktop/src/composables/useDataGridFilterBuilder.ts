import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { filterModeNeedsValue, filterModeUsesRange } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

export type DataGridStructuredFilterRule = {
  id: string;
  columnName: string;
  mode: DataGridContextFilterMode;
  rawValue: string;
  rawEndValue: string;
  conjunction: "AND" | "OR";
  disabled?: boolean;
};

export type UseDataGridFilterBuilderOptions = {
  columns: MaybeRefOrGetter<readonly string[]>;
  createId?: () => string;
  isComplete: (rule: DataGridStructuredFilterRule) => boolean;
  buildCondition: (rule: DataGridStructuredFilterRule) => Promise<string | undefined>;
};

export function buildDataGridStructuredWhere(items: Array<{ rule: DataGridStructuredFilterRule; condition: string }>): string {
  if (!items.length) return "";
  let result = items[0].condition;
  for (let index = 1; index < items.length; index++) {
    result = `(${result}) ${items[index].rule.conjunction} (${items[index].condition})`;
  }
  return result;
}

export function useDataGridFilterBuilder(options: UseDataGridFilterBuilderOptions) {
  const rules = ref<DataGridStructuredFilterRule[]>([]);
  const open = ref(false);
  const columnSearch = ref("");
  const appliedWhereInput = ref("");
  const filteredColumns = computed(() => {
    const query = columnSearch.value.trim().toLowerCase();
    return query ? toValue(options.columns).filter((column) => column.toLowerCase().includes(query)) : [...toValue(options.columns)];
  });
  const activeCount = computed(() => rules.value.filter((rule) => !rule.disabled && rule.columnName && options.isComplete(rule)).length);

  function defaultRule(): DataGridStructuredFilterRule {
    return { id: options.createId?.() ?? crypto.randomUUID(), columnName: toValue(options.columns)[0] ?? "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" };
  }
  function ensureRule() {
    if (!rules.value.length && toValue(options.columns).length) rules.value = [defaultRule()];
  }
  function addRule() {
    ensureRule();
    rules.value = [...rules.value, defaultRule()];
  }
  function removeRule(id: string) {
    rules.value = rules.value.filter((rule) => rule.id !== id);
    if (!rules.value.length) appliedWhereInput.value = "";
  }
  function updateRule(id: string, patch: Partial<DataGridStructuredFilterRule>) {
    rules.value = rules.value.map((rule) => {
      if (rule.id !== id) return rule;
      const next = { ...rule, ...patch };
      if (!filterModeNeedsValue(next.mode)) next.rawValue = next.rawEndValue = "";
      else if (!filterModeUsesRange(next.mode)) next.rawEndValue = "";
      return next;
    });
  }
  function reset() {
    appliedWhereInput.value = "";
    rules.value = toValue(options.columns).length ? [defaultRule()] : [];
  }
  async function buildWhere() {
    const items = (await Promise.all(rules.value.map(async (rule) => ({ rule, condition: !rule.disabled && rule.columnName && options.isComplete(rule) ? await options.buildCondition(rule) : undefined })))).filter(
      (item): item is { rule: DataGridStructuredFilterRule; condition: string } => !!item.condition,
    );
    return buildDataGridStructuredWhere(items);
  }
  async function apply() {
    appliedWhereInput.value = await buildWhere();
    open.value = false;
    return appliedWhereInput.value;
  }

  watch(open, (value) => {
    if (!value) columnSearch.value = "";
  });
  watch(
    () => [...toValue(options.columns)],
    (columns) => {
      if (!columns.length) rules.value = [];
      else rules.value = rules.value.map((rule) => (columns.includes(rule.columnName) ? rule : { ...rule, columnName: columns[0] }));
    },
  );

  return { rules, open, columnSearch, appliedWhereInput, filteredColumns, activeCount, defaultRule, ensureRule, addRule, removeRule, updateRule, reset, buildWhere, apply };
}
