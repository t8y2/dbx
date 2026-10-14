import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";

export type StarRocksDistribution = "auto" | "hash" | "random";
export type StarRocksTimeGranularity = "year" | "month" | "day" | "hour";
export type StarRocksPartitionKind = "none" | "time" | "values" | "range" | "list";
export interface StarRocksRangeDraft {
  id: string;
  name: string;
  lower: Record<string, string>;
  upper: Record<string, string>;
}
export interface StarRocksListDraft {
  id: string;
  name: string;
  values: Array<{ id: string; fields: Record<string, string> }>;
}
export interface StarRocksPhysicalOptionsDraft {
  partitionKind: StarRocksPartitionKind;
  partitionColumnIds: string[];
  rangePartitions: StarRocksRangeDraft[];
  listPartitions: StarRocksListDraft[];
  timeInterval: string;
  timePartitionEnabled: boolean;
  partitionColumnId: string;
  granularity: StarRocksTimeGranularity;
  distribution: StarRocksDistribution;
  distributionColumnIds: string[];
  sortColumnIds: string[];
  bucketCount: string;
}
export interface CreateTableDialectOptions {
  starrocks?: {
    timePartition?: { columnId: string; granularity: StarRocksTimeGranularity; interval?: number; additionalColumnIds: string[] };
    partition?: { kind: "values"; columnIds: string[] } | { kind: "range"; columnIds: string[]; partitions: Array<{ name: string; lower: string[]; upper: string[] }> } | { kind: "list"; columnIds: string[]; partitions: Array<{ name: string; values: string[][] }> };
    distribution: StarRocksDistribution;
    distributionColumnIds: string[];
    sortColumnIds: string[];
    bucketCount?: number;
  };
}

export function emptyStarRocksPhysicalOptions(): StarRocksPhysicalOptionsDraft {
  return { partitionKind: "none", partitionColumnIds: [], rangePartitions: [], listPartitions: [], timeInterval: "", timePartitionEnabled: false, partitionColumnId: "", granularity: "month", distribution: "auto", distributionColumnIds: [], sortColumnIds: [], bucketCount: "" };
}

export function restoreStarRocksPhysicalOptions(saved?: StarRocksPhysicalOptionsDraft): StarRocksPhysicalOptionsDraft {
  return {
    ...emptyStarRocksPhysicalOptions(),
    ...saved,
    partitionKind: saved?.partitionKind === "none" && saved.timePartitionEnabled ? "time" : (saved?.partitionKind ?? (saved?.timePartitionEnabled ? "time" : "none")),
    partitionColumnIds: [...(saved?.partitionColumnIds ?? [])],
    distributionColumnIds: [...(saved?.distributionColumnIds ?? [])],
    sortColumnIds: [...(saved?.sortColumnIds ?? [])],
    rangePartitions: (saved?.rangePartitions ?? []).map((row) => ({ ...row, lower: { ...row.lower }, upper: { ...row.upper } })),
    listPartitions: (saved?.listPartitions ?? []).map((row) => ({ ...row, values: row.values.map((tuple) => ({ ...tuple, fields: { ...tuple.fields } })) })),
  };
}

export function hasStarRocksPhysicalOptions(draft: StarRocksPhysicalOptionsDraft): boolean {
  return draft.sortColumnIds.length > 0 || draft.partitionKind !== "none" || draft.timePartitionEnabled || draft.distribution !== "auto" || !!draft.bucketCount.trim();
}

export function isStarRocksTimeColumn(column: Pick<EditableStructureColumn, "dataType">): boolean {
  return /^(date|datetime)$/i.test(column.dataType.trim());
}

export function isStarRocksHashColumn(column: Pick<EditableStructureColumn, "dataType">): boolean {
  return /^(tinyint|smallint|int|integer|bigint|largeint|date|datetime|char|varchar|string)$/i.test(column.dataType.split("(")[0]!.trim());
}

export function isStarRocksPartitionColumn(column: Pick<EditableStructureColumn, "dataType">, range = false): boolean {
  const base = column.dataType.split("(")[0]!.trim();
  return range ? /^(tinyint|smallint|int|integer|bigint|largeint|date|datetime)$/i.test(base) : isStarRocksHashColumn(column) || /^boolean$/i.test(base);
}

export function buildStarRocksDialectOptions(draft: StarRocksPhysicalOptionsDraft): CreateTableDialectOptions {
  const rawCount = draft.bucketCount.trim();
  const count = Number(rawCount);
  const kind = draft.partitionKind === "none" && draft.timePartitionEnabled ? "time" : draft.partitionKind;
  const columnIds = [...draft.partitionColumnIds];
  const values = (fields: Record<string, string>) => columnIds.map((id) => fields[id] ?? "");
  let partition: NonNullable<CreateTableDialectOptions["starrocks"]>["partition"];
  if (kind === "values") partition = { kind, columnIds };
  if (kind === "range") partition = { kind, columnIds, partitions: draft.rangePartitions.map((row) => ({ name: row.name, lower: values(row.lower), upper: values(row.upper) })) };
  if (kind === "list") partition = { kind, columnIds, partitions: draft.listPartitions.map((row) => ({ name: row.name, values: row.values.map((tuple) => values(tuple.fields)) })) };
  const rawInterval = draft.timeInterval.trim();
  const interval = Number(rawInterval);
  return {
    starrocks: {
      partition,
      timePartition:
        kind === "time"
          ? {
              columnId: draft.partitionColumnId,
              granularity: draft.granularity,
              additionalColumnIds: columnIds,
              interval: rawInterval ? (Number.isSafeInteger(interval) && interval > 0 && interval <= 2147483647 ? interval : 0) : undefined,
            }
          : undefined,
      distribution: draft.distribution,
      // Keep stale IDs so deletion/type changes cannot silently change the table layout.
      distributionColumnIds: draft.distribution === "hash" ? [...draft.distributionColumnIds] : [],
      sortColumnIds: [...draft.sortColumnIds],
      bucketCount: rawCount ? (Number.isSafeInteger(count) && count > 0 && count <= 2147483647 ? count : 0) : undefined,
    },
  };
}

export function isStarRocksSortColumn(column: Pick<EditableStructureColumn, "dataType">, primaryKeyTable: boolean): boolean {
  return !primaryKeyTable || /^(boolean|tinyint|smallint|int|integer|bigint|largeint|varchar|string|date|datetime)$/i.test(column.dataType.split("(")[0]!.trim());
}
