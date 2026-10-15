import type { tabularResultItems } from "@/lib/tabs/tabPresentation";

export type ResultItem = ReturnType<typeof tabularResultItems>[number];

export function filterResultItems(items: ResultItem[], rawQuery: string, t: (key: string, params?: Record<string, unknown>) => string): ResultItem[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return items;
  // A number is an exact result ordinal, not a substring of every SQL statement.
  if (/^\d+$/.test(query)) return items.filter((item) => item.n === Number(query));
  return items.filter((item) => [item.label, item.title, item.result.sourceName, item.result.sourceLabel, item.result.sourceStatement, t("tabs.resultN", { n: item.n })].some((value) => value?.toLocaleLowerCase().includes(query)));
}
