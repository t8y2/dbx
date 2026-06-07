export type RowStatus = "clean" | "edited" | "new" | "deleted";
export type RowStatusFilter = "all" | "changed" | "edited" | "new" | "deleted";

export function matchesRowStatusFilter(status: RowStatus, filter: RowStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "changed") return status !== "clean";
  return status === filter;
}

export function rowStatusFilterAfterAddingRow(filter: RowStatusFilter): RowStatusFilter {
  return matchesRowStatusFilter("new", filter) ? filter : "all";
}
