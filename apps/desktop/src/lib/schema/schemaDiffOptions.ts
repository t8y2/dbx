import type { BooleanSchemaDiffCompareOptionKey, SchemaDiffCompareOptions, SchemaDiffOptionItem } from "@/types/schemaDiff";

export const POSTGRES_SCHEMA_DIFF_OPTIONS: SchemaDiffOptionItem[] = [
  {
    id: "tables",
    labelKey: "schemaDiff.options.tables",
    defaultChecked: true,
    children: [
      { id: "primaryKeys", labelKey: "schemaDiff.options.primaryKeys", defaultChecked: true },
      { id: "foreignKeys", labelKey: "schemaDiff.options.foreignKeys", defaultChecked: true },
      { id: "uniqueKeys", labelKey: "schemaDiff.options.uniqueKeys", defaultChecked: true },
      { id: "checks", labelKey: "schemaDiff.options.checks", defaultChecked: true },
      { id: "exclusions", labelKey: "schemaDiff.options.exclusions", defaultChecked: true },
    ],
  },
  { id: "views", labelKey: "schemaDiff.options.views", defaultChecked: true },
  { id: "functions", labelKey: "schemaDiff.options.functions", defaultChecked: true },
  { id: "indexes", labelKey: "schemaDiff.options.indexes", defaultChecked: true },
  { id: "sequences", labelKey: "schemaDiff.options.sequences", defaultChecked: true },
  { id: "triggers", labelKey: "schemaDiff.options.triggers", defaultChecked: true },
  { id: "rules", labelKey: "schemaDiff.options.rules", defaultChecked: true },
  { id: "owners", labelKey: "schemaDiff.options.owners", defaultChecked: true },
  { id: "cascadeDelete", labelKey: "schemaDiff.options.cascadeDelete", defaultChecked: false },
  { id: "sequenceLastValues", labelKey: "schemaDiff.options.sequenceLastValues", defaultChecked: true },
  { id: "compareColumnOrder", labelKey: "schemaDiff.options.compareColumnOrder", defaultChecked: false },
];

export const SCHEMA_DIFF_OPTIONS_BY_DB_TYPE: Record<string, SchemaDiffOptionItem[]> = {
  postgres: POSTGRES_SCHEMA_DIFF_OPTIONS,
  opengauss: POSTGRES_SCHEMA_DIFF_OPTIONS,
  // mysql: [...] 后续扩展
  // sqlserver: [...] 后续扩展
};

export function getSchemaDiffOptionsForDbType(dbType: string): SchemaDiffOptionItem[] {
  return SCHEMA_DIFF_OPTIONS_BY_DB_TYPE[dbType] ?? POSTGRES_SCHEMA_DIFF_OPTIONS;
}

export function getOptionIdsFromTree(items: SchemaDiffOptionItem[]): BooleanSchemaDiffCompareOptionKey[] {
  const ids: BooleanSchemaDiffCompareOptionKey[] = [];
  for (const item of items) {
    ids.push(item.id);
    if (item.children) {
      ids.push(...getOptionIdsFromTree(item.children));
    }
  }
  return ids;
}

export function buildDefaultOptionsFromTree(items: SchemaDiffOptionItem[]): SchemaDiffCompareOptions {
  const options = {} as SchemaDiffCompareOptions;
  for (const item of items) {
    options[item.id] = item.defaultChecked as never;
    if (item.children) {
      const childDefaults = buildDefaultOptionsFromTree(item.children);
      Object.assign(options, childDefaults);
    }
  }
  return options;
}
