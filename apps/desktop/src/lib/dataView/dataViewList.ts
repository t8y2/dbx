import type { DataViewSummary } from "@/types/dataView";

/**
 * Filter data view summaries by a free-text query, matched case-insensitively
 * against the view name and description. An empty or whitespace-only query
 * returns every summary unmodified.
 */
export function filterDataViewSummaries(summaries: DataViewSummary[], query: string): DataViewSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return summaries;
  return summaries.filter((summary) => {
    if (summary.name.toLowerCase().includes(needle)) return true;
    const description = summary.description?.toLowerCase();
    return description ? description.includes(needle) : false;
  });
}
