export const DRIVER_CATEGORIES = [
  { key: "sql", order: 1, titleKey: "connection.databaseCategorySql" },
  { key: "analytics", order: 2, titleKey: "connection.databaseCategoryAnalytics" },
  { key: "domestic", order: 3, titleKey: "connection.databaseCategoryDomestic" },
  { key: "lightweight", order: 4, titleKey: "connection.databaseCategoryLightweight" },
  { key: "document", order: 5, titleKey: "connection.databaseCategoryDocument" },
  { key: "graph_ai", order: 6, titleKey: "connection.databaseCategoryGraphAi" },
  { key: "timeseries", order: 7, titleKey: "connection.databaseCategoryTimeseries" },
  { key: "mq", order: 8, titleKey: "connection.databaseCategoryMq" },
  { key: "registry_config", order: 9, titleKey: "connection.databaseCategoryRegistryConfig" },
] as const;

export type DriverCategoryKey = (typeof DRIVER_CATEGORIES)[number]["key"];

const VALID_CATEGORY_KEYS: ReadonlySet<string> = new Set(DRIVER_CATEGORIES.map((cat) => cat.key));

const EMPTY = 0;

export const AGENT_DRIVER_CATEGORY_MAP: Readonly<Record<string, DriverCategoryKey>> = {
  access: "lightweight",
  bigquery: "analytics",
  cassandra: "document",
  dameng: "domestic",
  databend: "analytics",
  databricks: "analytics",
  db2: "sql",
  duckdb: "lightweight",
  etcd: "registry_config",
  exasol: "analytics",
  firebird: "sql",
  gbase8a: "domestic",
  gbase8s: "domestic",
  goldendb: "domestic",
  h2: "lightweight",
  "h2-legacy": "lightweight",
  highgo: "domestic",
  hive: "analytics",
  influxdb: "timeseries",
  informix: "sql",
  iotdb: "timeseries",
  iris: "sql",
  kafka: "mq",
  kingbase: "domestic",
  kylin: "analytics",
  mongodb: "document",
  neo4j: "graph_ai",
  "oceanbase-oracle": "domestic",
  oracle: "sql",
  oscar: "domestic",
  phoenix: "analytics",
  prestosql: "analytics",
  rabbitmq: "mq",
  rocketmq: "mq",
  saphana: "analytics",
  snowflake: "analytics",
  spark: "analytics",
  "sqlserver-legacy": "sql",
  sundb: "domestic",
  tdengine: "timeseries",
  teradata: "analytics",
  trino: "analytics",
  uxdb: "domestic",
  vastbase: "domestic",
  vertica: "analytics",
  xugu: "domestic",
  yashandb: "domestic",
  zookeeper: "registry_config",
};

export const getCategoryForAgentDriver = (dbType: string): DriverCategoryKey | "all" => AGENT_DRIVER_CATEGORY_MAP[dbType] ?? "all";

const collectUnmapped = (driverKeys: string[]): string[] => driverKeys.filter((key) => !(key in AGENT_DRIVER_CATEGORY_MAP));

const collectUnknownCategories = (): string[] =>
  Object.entries(AGENT_DRIVER_CATEGORY_MAP)
    .filter(([, category]) => !VALID_CATEGORY_KEYS.has(category))
    .map(([key, category]) => `${key}->${category}`);

const collectDuplicateKeys = (driverKeys: string[]): string[] => driverKeys.filter((key, index) => driverKeys.indexOf(key) !== index).filter((key, index, arr) => arr.indexOf(key) === index);

const formatErrorMessage = (unmapped: string[], unknownCategories: string[], duplicateKeys: string[]): string => {
  const parts: string[] = [];
  if (unmapped.length > EMPTY) {
    parts.push(`unmapped=${unmapped.join(",")}`);
  }
  if (unknownCategories.length > EMPTY) {
    parts.push(`unknownCategories=${unknownCategories.join(",")}`);
  }
  if (duplicateKeys.length > EMPTY) {
    parts.push(`duplicateKeys=${duplicateKeys.join(",")}`);
  }
  return parts.join("; ");
};

/**
 * Validates that every driver key in {@link agentDriverDbTypes} has a category
 * mapping and that all mapped categories are valid. Throws if any driver is
 * unmapped, duplicates appear, or an unknown category is referenced.
 */
export const assertAgentDriverCategoriesComplete = (agentDriverDbTypes: string[]): void => {
  const unmapped = collectUnmapped(agentDriverDbTypes);
  const unknownCategories = collectUnknownCategories();
  const duplicateKeys = collectDuplicateKeys(agentDriverDbTypes);

  if (unmapped.length > EMPTY || unknownCategories.length > EMPTY || duplicateKeys.length > EMPTY) {
    throw new Error(formatErrorMessage(unmapped, unknownCategories, duplicateKeys));
  }

  // Warn in dev if the map has stale entries for drivers not in the catalog.
  if (import.meta.env.DEV) {
    const driverSet = new Set(agentDriverDbTypes);
    const mappedButNotListed = Object.keys(AGENT_DRIVER_CATEGORY_MAP).filter((key) => !driverSet.has(key));
    if (mappedButNotListed.length > EMPTY) {
      // eslint-disable-next-line no-console
      console.warn("[driver-category-definitions] agent driver category map has entries for drivers not in the supplied list:", mappedButNotListed.join(", "));
    }
  }
};
