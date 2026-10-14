/** StarRocks product capabilities, based on current_version(), never MySQL VERSION(). */
export interface StarRocksCapabilities {
  alterDistribution: boolean;
  defaultBuckets: boolean;
  primaryKeySorting: boolean;
  duplicateKeySorting: boolean;
  defaultFunctions: boolean;
  renameColumn: boolean;
  tableComment: boolean;
  versionKnown: boolean;
  timePartitioning: boolean;
  randomDistribution: boolean;
  valuePartitioning: boolean;
  mixedPartitioning: boolean;
  dataTypes: string[];
}

export const STARROCKS_DATA_TYPES = ["boolean", "tinyint", "smallint", "int", "bigint", "largeint", "float", "double", "decimal", "date", "datetime", "char", "varchar", "string", "binary", "varbinary", "json", "array<int>", "map<int, int>", "struct<field int>", "bitmap", "hll", "percentile"];

export function getStarRocksCapabilities(productVersion?: string): StarRocksCapabilities {
  const match = productVersion?.trim().match(/^(?:StarRocks(?: version)?\s+)?v?(\d+)\.(\d+)(?:\.(\d+))?/i);
  const version = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
  const versionKnown = !!version && version.join(".") !== "5.1.0";
  const atLeast = (major: number, minor: number) => versionKnown && (version![0]! > major || (version![0] === major && version![1]! >= minor));
  // Product introduction versions: JSON 2.2, BINARY 3.0, MAP/STRUCT 3.1, DECIMAL256 4.0.
  const dataTypes = STARROCKS_DATA_TYPES.filter((type) => {
    if (type === "binary" || type === "varbinary") return atLeast(3, 0);
    if (type.startsWith("map<") || type.startsWith("struct<")) return atLeast(3, 1);
    if (type === "json") return atLeast(2, 2);
    return true;
  });
  if (atLeast(4, 0)) dataTypes.push("decimal256");
  // 3.1 covers time partitions in both shared-data and shared-nothing deployments.
  return {
    alterDistribution: atLeast(3, 2),
    defaultBuckets: atLeast(4, 1) || (atLeast(4, 0) && version![2]! >= 1) || (atLeast(3, 5) && version![2]! >= 8),
    renameColumn: atLeast(3, 4) || (atLeast(3, 3) && version![2]! >= 2),
    tableComment: atLeast(3, 1),
    defaultFunctions: atLeast(3, 0),
    primaryKeySorting: atLeast(3, 0),
    duplicateKeySorting: atLeast(3, 3),
    versionKnown,
    dataTypes,
    timePartitioning: atLeast(3, 1),
    randomDistribution: atLeast(3, 1),
    valuePartitioning: atLeast(3, 2) || (atLeast(3, 1) && version![2]! >= 1),
    mixedPartitioning: atLeast(3, 4),
  };
}
