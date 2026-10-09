import type { ObjectSpaceStatistics } from "@/types/database";
import { formatObjectBrowserBytes } from "@/lib/table/objectBrowserRows";

export function oceanbaseSpaceText(space: ObjectSpaceStatistics | null | undefined, t: (key: string) => string): string {
  if (space?.allocated_bytes != null) return formatObjectBrowserBytes(space.allocated_bytes);
  return t(`objects.spaceStatus.${space?.status ?? "unknown"}`);
}

export function oceanbaseSpaceHint(space: ObjectSpaceStatistics | null | undefined, t: (key: string) => string): string {
  return oceanbaseSpaceRows(space, t).map((row) => `${row.label}: ${row.value}`).join("\n");
}

export function oceanbaseSpaceRows(space: ObjectSpaceStatistics | null | undefined, t: (key: string) => string): { label: string; value: string }[] {
  if (!space) return [];
  const status = (value: string) => t(`objects.spaceStatus.${value}`);
  const bytes = (value: number | null | undefined) => value == null ? t("objects.spaceStatus.unknown") : formatObjectBrowserBytes(value);
  const rows = [
    { label: t("objects.spaceSource"), value: space.source },
    { label: t("objects.spaceScope"), value: t("objects.spaceLeader") },
    { label: t("objects.spaceState"), value: status(space.status) },
    { label: t("objects.spaceData"), value: bytes(space.data_bytes) },
    { label: t("objects.spaceAllocated"), value: bytes(space.allocated_bytes) },
    { label: t("objects.spaceComponentsState"), value: status(space.components_status) },
  ];
  for (const [kind, key] of [["USER TABLE", "spaceBase"], ["INDEX", "spaceIndexes"], ["LOB AUX TABLE", "spaceLob"]]) {
    const component = space.components.find((entry) => entry.kind === kind);
    rows.push({ label: `${t(`objects.${key}`)} · ${t("objects.spaceData")}`, value: bytes(component?.data_bytes) });
    rows.push({ label: `${t(`objects.${key}`)} · ${t("objects.spaceAllocated")}`, value: bytes(component?.allocated_bytes) });
  }
  rows.push({ label: t("objects.spaceMetric"), value: t("objects.spaceMetricHelp") });
  return rows;
}
