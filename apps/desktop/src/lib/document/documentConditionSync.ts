import { currentDocumentSortJson, type DocumentFilterMode, type DocumentFilterRule } from "@/lib/app/documentStoreProvider";
import type { DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";

type SortRule = Omit<DataGridStructuredSortRule, "id">;
type FilterRule = Omit<DocumentFilterRule, "id">;

export function parseMongoSortInput(input: string): SortRule[] | undefined {
  try {
    const json = currentDocumentSortJson(input);
    if (!json) return [];
    const sort = JSON.parse(json) as unknown;
    if (!sort || typeof sort !== "object" || Array.isArray(sort)) return undefined;
    const entries = Object.entries(sort);
    if (entries.some(([, value]) => value !== 1 && value !== -1)) return undefined;
    return entries.map(([columnName, direction]) => ({ columnName, direction: direction === 1 ? "asc" : "desc" }));
  } catch {
    return undefined;
  }
}

export function buildMongoSortInput(rules: readonly DataGridStructuredSortRule[]): string | undefined {
  const active = rules.filter((rule) => !rule.disabled);
  if (active.some((rule) => !rule.columnName) || new Set(active.map((rule) => rule.columnName)).size !== active.length) return undefined;
  return JSON.stringify(Object.fromEntries(active.map((rule) => [rule.columnName, rule.direction === "asc" ? 1 : -1])));
}

/** Complex Mongo operators stay in the JSON editor instead of being approximated. */
export function parseMongoFilterRules(filter: Record<string, unknown>): FilterRule[] | undefined {
  let conjunction: "AND" | "OR" | undefined;
  const operators: Record<string, DocumentFilterMode> = { $eq: "equals", $ne: "not-equals", $gt: "greater-than", $gte: "greater-than-or-equal", $lt: "less-than", $lte: "less-than-or-equal", $in: "in", $nin: "not-in" };
  function valueRule(fieldName: string, value: unknown, mode: DocumentFilterMode = "equals"): FilterRule {
    const rule: FilterRule = { fieldName, mode, rawValue: "", rawEndValue: "", conjunction: "AND", valueType: "auto" };
    if (value === null) return { ...rule, mode: mode === "not-equals" ? "is-not-null" : "is-null" };
    if (typeof value === "string") return value.trim() ? { ...rule, rawValue: value, valueType: "string" } : { ...rule, rawValue: JSON.stringify(value), valueType: "json" };
    if (typeof value === "number" || typeof value === "boolean") return { ...rule, rawValue: String(value), valueType: typeof value === "number" ? "number" : "boolean" };
    return { ...rule, rawValue: JSON.stringify(value), valueType: "json" };
  }
  function parse(object: Record<string, unknown>): FilterRule[] | undefined {
    const entries = Object.entries(object);
    const rules: FilterRule[] = [];
    for (const [field, value] of entries) {
      if (field === "$and" || field === "$or") {
        const next = field === "$and" ? "AND" : "OR";
        if ((conjunction && conjunction !== next) || !Array.isArray(value) || !value.length || (entries.length > 1 && next === "OR")) return undefined;
        conjunction = next;
        for (const child of value) {
          if (!child || typeof child !== "object" || Array.isArray(child)) return undefined;
          const parsed = parse(child as Record<string, unknown>);
          if (!parsed) return undefined;
          rules.push(...parsed);
        }
      } else {
        if (field.startsWith("$")) return undefined;
        if (entries.length > 1 && conjunction === "OR") return undefined;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const conditions = Object.entries(value);
          if (conditions.some(([key]) => key.startsWith("$") && !["$oid", "$date", "$numberInt", "$numberLong", "$numberDecimal", "$numberDouble"].includes(key))) {
            if (conditions.length !== 1 || !operators[conditions[0]![0]]) return undefined;
            const [operator, operand] = conditions[0]!;
            if (operand === null && operator !== "$eq" && operator !== "$ne") return undefined;
            if (operator === "$in" || operator === "$nin") {
              if (!Array.isArray(operand) || !operand.length || operand.some((item) => item !== null && typeof item === "object")) return undefined;
              rules.push({ ...valueRule(field, operand, operators[operator]), rawValue: operand.map((item) => JSON.stringify(item)).join(", "), valueType: "auto" });
              continue;
            }
            rules.push(valueRule(field, operand, operators[operator]));
            continue;
          }
        }
        rules.push(valueRule(field, value));
      }
    }
    return rules;
  }
  return parse(filter)?.map((rule) => ({ ...rule, conjunction: conjunction ?? "AND" }));
}
