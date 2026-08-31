import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { filterModeNeedsValue, filterModeUsesRange } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";

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

export function moveDataGridStructuredFilterRule(rules: readonly DataGridStructuredFilterRule[], ruleId: string, targetIndex: number): DataGridStructuredFilterRule[] {
  const sourceIndex = rules.findIndex((rule) => rule.id === ruleId);
  if (sourceIndex < 0 || rules.length < 2) return [...rules];
  const nextIndex = Math.min(rules.length - 1, Math.max(0, Math.trunc(targetIndex)));
  if (sourceIndex === nextIndex) return [...rules];
  const nextRules = [...rules];
  const [rule] = nextRules.splice(sourceIndex, 1);
  nextRules.splice(nextIndex, 0, rule);
  return nextRules;
}

export function createDataGridFilterConditionCache() {
  const entries = new Map<string, { signature: string; condition: Promise<string | null> }>();

  function resolve(ruleId: string, signature: string, build: () => Promise<string | null>): Promise<string | null> {
    const cached = entries.get(ruleId);
    if (cached?.signature === signature) return cached.condition;

    let condition: Promise<string | null>;
    condition = Promise.resolve()
      .then(build)
      .catch((error) => {
        if (entries.get(ruleId)?.condition === condition) entries.delete(ruleId);
        throw error;
      });
    entries.set(ruleId, { signature, condition });
    return condition;
  }

  function retain(ruleIds: readonly string[]) {
    const retained = new Set(ruleIds);
    for (const ruleId of entries.keys()) {
      if (!retained.has(ruleId)) entries.delete(ruleId);
    }
  }

  return { resolve, retain };
}

export function useDataGridFilterBuilder(options: UseDataGridFilterBuilderOptions) {
  const rules = ref<DataGridStructuredFilterRule[]>([]);
  const open = ref(false);
  const columnSearch = ref("");
  const appliedWhereInput = ref("");
  const filteredColumns = computed(() => {
    const query = columnSearch.value.trim();
    return query ? toValue(options.columns).filter((column) => matchesIdentifierSearch(column, query)) : [...toValue(options.columns)];
  });
  const activeCount = computed(() => rules.value.filter((rule) => !rule.disabled && rule.columnName && options.isComplete(rule)).length);

  function defaultRule(): DataGridStructuredFilterRule {
    return { id: options.createId?.() ?? crypto.randomUUID(), columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" };
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
  function moveRule(id: string, targetIndex: number) {
    rules.value = moveDataGridStructuredFilterRule(rules.value, id, targetIndex);
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
      else rules.value = rules.value.map((rule) => (!rule.columnName || columns.includes(rule.columnName) ? rule : { ...rule, columnName: columns[0] }));
    },
  );

  return { rules, open, columnSearch, appliedWhereInput, filteredColumns, activeCount, defaultRule, ensureRule, addRule, removeRule, updateRule, moveRule, reset, buildWhere, apply };
}
