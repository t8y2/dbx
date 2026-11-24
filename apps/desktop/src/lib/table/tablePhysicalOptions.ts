import type { EditableStructureColumn, TranswarpCreateTableOptions } from "@/lib/table/tableStructureEditorSql";

export interface TablePhysicalOptionsDraft {
  partitionRanges?: { name: string; lower: string; upper: string }[];
  partitionMode?: "none" | "range" | "value" | "day" | "month" | "year" | "group";
  partitionTarget?: string;
  partitionGroups?: string;
  generatePartition?: boolean;
  partitionColumnIds: string[];
  distributionColumnIds: string[];
  bucketCount: string;
  storageFormat: string;
  transactional: boolean;
  propertyRows?: [string, string][];
}

export interface TablePhysicalOptionsConfig {
  partitionColumnsLabel: string;
  distributionColumnsLabel: string;
  bucketCountLabel: string;
  storageFormatLabel: string;
  transactionalLabel?: string;
  maxBuckets: number;
  minBuckets?: number;
  tableProperties?: boolean;
  paimonPartitioning?: boolean;
  storageFormats: readonly string[];
}

export const INCEPTOR_PHYSICAL_OPTIONS: TablePhysicalOptionsConfig = {
  partitionColumnsLabel: "structureEditor.transwarpPartitionColumns",
  distributionColumnsLabel: "structureEditor.transwarpBucketColumns",
  bucketCountLabel: "structureEditor.transwarpBucketCount",
  storageFormatLabel: "structureEditor.transwarpStorageFormat",
  transactionalLabel: "structureEditor.transwarpTransactional",
  maxBuckets: 4096,
  storageFormats: ["ORC", "PARQUET", "TEXTFILE"],
};

export const PAIMON_PHYSICAL_OPTIONS: TablePhysicalOptionsConfig = {
  ...INCEPTOR_PHYSICAL_OPTIONS,
  transactionalLabel: undefined,
  storageFormats: [],
  minBuckets: -2,
  maxBuckets: 2147483647,
  tableProperties: true,
  paimonPartitioning: true,
};

export function emptyTablePhysicalOptions(): TablePhysicalOptionsDraft {
  return { partitionColumnIds: [], distributionColumnIds: [], bucketCount: "", storageFormat: "", transactional: false };
}

export function hasTablePhysicalOptions(draft: TablePhysicalOptionsDraft): boolean {
  return (
    (!!draft.partitionMode && draft.partitionMode !== "value") || draft.partitionColumnIds.length > 0 || draft.distributionColumnIds.length > 0 || !!draft.bucketCount.trim() || !!draft.storageFormat || draft.transactional || !!draft.propertyRows?.some(([key, value]) => key.trim() || value.trim())
  );
}

export function pruneTablePhysicalOptions(draft: TablePhysicalOptionsDraft, availableColumnIds: ReadonlySet<string>): TablePhysicalOptionsDraft {
  const partitionColumnIds = draft.partitionColumnIds.filter((id) => availableColumnIds.has(id));
  const distributionColumnIds = draft.distributionColumnIds.filter((id) => availableColumnIds.has(id));
  if (partitionColumnIds.length === draft.partitionColumnIds.length && distributionColumnIds.length === draft.distributionColumnIds.length) return draft;
  return { ...draft, partitionColumnIds, distributionColumnIds };
}

export function restoreTablePhysicalOptions(saved: { physicalOptions?: TablePhysicalOptionsDraft & { properties?: string } }): TablePhysicalOptionsDraft {
  if (!saved.physicalOptions) return emptyTablePhysicalOptions();
  return {
    partitionRanges: saved.physicalOptions.partitionRanges?.map((row) => ({ ...row })),
    partitionMode: saved.physicalOptions.partitionMode,
    partitionTarget: saved.physicalOptions.partitionTarget,
    partitionGroups: saved.physicalOptions.partitionGroups,
    generatePartition: saved.physicalOptions.generatePartition,
    partitionColumnIds: [...saved.physicalOptions.partitionColumnIds],
    distributionColumnIds: [...saved.physicalOptions.distributionColumnIds],
    bucketCount: saved.physicalOptions.bucketCount,
    storageFormat: saved.physicalOptions.storageFormat,
    transactional: saved.physicalOptions.transactional,
    propertyRows:
      saved.physicalOptions.propertyRows?.map(([key, value]) => [key, value]) ??
      saved.physicalOptions.properties
        ?.split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          const separator = line.indexOf("=");
          return separator < 0 ? [line.trim(), ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
  };
}

export function buildInceptorCreateOptions(draft: TablePhysicalOptionsDraft, columns: readonly Pick<EditableStructureColumn, "id" | "name">[]): TranswarpCreateTableOptions {
  const names = (ids: readonly string[]) => ids.map((id) => columns.find((column) => column.id === id)?.name ?? id);
  const count = draft.bucketCount.trim();
  const parsedCount = Number(count);
  return {
    partitionColumns: names(draft.partitionColumnIds),
    bucketColumns: names(draft.distributionColumnIds),
    bucketCount: count ? (Number.isSafeInteger(parsedCount) && parsedCount > 0 && parsedCount <= 4096 ? parsedCount : 0) : undefined,
    storageFormat: draft.storageFormat || undefined,
    transactional: draft.transactional,
  };
}

export function paimonGroupExpression(mapping: string, source: string): string {
  const literal = (value: string) => "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  const seen = new Set<string>();
  const clauses = mapping
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const split = line.indexOf("=");
      const group = line.slice(0, split).trim();
      const values = line
        .slice(split + 1)
        .split(",")
        .map((value) => value.trim());
      if (split < 1 || !group || values.some((value) => !value)) throw new Error("Group mapping: NAME=value1,value2");
      for (const value of values) {
        if (seen.has(value)) throw new Error("Duplicate partition value: " + value);
        seen.add(value);
      }
      return "WHEN CAST(" + source + " AS STRING) IN (" + values.map(literal).join(", ") + ") THEN " + literal(group);
    });
  if (!clauses.length) throw new Error("Group mapping: NAME=value1,value2");
  return "CASE " + clauses.join(" ") + " ELSE 'OTHER' END";
}

export function paimonWriteExpression(draft: TablePhysicalOptionsDraft, source: string): string {
  switch (draft.partitionMode) {
    case "day":
      return "CAST(" + source + " AS DATE)";
    case "month":
      return "TRUNC(CAST(" + source + " AS DATE), 'MONTH')";
    case "year":
      return "YEAR(" + source + ")";
    case "group":
      return paimonGroupExpression(draft.partitionGroups ?? "", source);
    case "range": {
      const rows = draft.partitionRanges ?? [];
      if (!rows.length) throw new Error("Add a numeric partition range.");
      const ranges: { low: number; high: number }[] = [];
      const clauses = rows.map(({ name, lower, upper }) => {
        const low = Number(lower),
          high = Number(upper);
        if (!name.trim() || !/^-?\d+$/.test(lower) || !/^-?\d+$/.test(upper) || !Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low >= high || ranges.some((r) => low < r.high && high > r.low)) throw new Error("Enter named, non-overlapping integer ranges [lower, upper).");
        ranges.push({ low, high });
        const label = name.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
        return `WHEN ${source} >= ${low} AND ${source} < ${high} THEN '${label}'`;
      });
      return "CASE " + clauses.join(" ") + " ELSE 'OTHER' END";
    }
    default:
      return "";
  }
}
