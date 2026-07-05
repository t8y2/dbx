export type MetadataScopeValue = string | number | boolean | null | undefined;

export interface MetadataScopeInput {
  kind: string;
  connectionId?: string | null;
  database?: string | null;
  schema?: string | null;
  nodeKind?: string | null;
  tableName?: string | null;
  tableType?: string | null;
  objectTypes?: readonly (string | null | undefined)[] | null;
  searchFilter?: string | null;
  limit?: number | null;
  offset?: number | null;
  sidebarDisplayMode?: string | null;
  driverProfile?: string | null;
  extra?: Record<string, MetadataScopeValue | readonly MetadataScopeValue[]> | null;
}

function normalizeString(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value;
}

function normalizeSearchFilter(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeObjectTypes(values: readonly (string | null | undefined)[] | null | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const normalized = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toUpperCase().replace(/\s+/g, "_"))
    .sort();
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function stableEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
}

function normalizeExtra(extra: MetadataScopeInput["extra"]): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const entries = stableEntries(extra)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, value.filter((item) => item !== undefined)] as const;
      }
      return [key, value] as const;
    })
    .filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined;
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function metadataScopeParts(input: MetadataScopeInput): Record<string, unknown> {
  return {
    kind: input.kind,
    connectionId: normalizeString(input.connectionId),
    database: normalizeString(input.database),
    schema: normalizeString(input.schema),
    nodeKind: normalizeString(input.nodeKind),
    tableName: normalizeString(input.tableName),
    tableType: normalizeString(input.tableType),
    objectTypes: normalizeObjectTypes(input.objectTypes),
    searchFilter: normalizeSearchFilter(input.searchFilter),
    limit: normalizeNumber(input.limit),
    offset: normalizeNumber(input.offset),
    sidebarDisplayMode: normalizeString(input.sidebarDisplayMode),
    driverProfile: normalizeString(input.driverProfile),
    extra: normalizeExtra(input.extra),
  };
}

export function metadataScopeKey(input: MetadataScopeInput): string {
  return JSON.stringify(stableEntries(metadataScopeParts(input)));
}
