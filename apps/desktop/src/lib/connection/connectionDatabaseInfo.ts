import type { ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, IdentifierCase } from "@/types/database";

export type DatabaseInfoField = keyof DatabaseConnectionInfo;

export interface DatabaseInfoRow {
  key: DatabaseInfoField;
  value: string;
}

const DATABASE_INFO_FIELDS: readonly DatabaseInfoField[] = ["productName", "productVersion", "currentDatabase", "serverComment", "serverCharset", "serverCollation", "unquotedIdentifierCase", "quotedIdentifierCase", "driverName", "driverVersion", "jdbcVersion"];
const IDENTIFIER_CASES = new Set<IdentifierCase>(["lower", "upper", "mixed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function identifierCase(value: unknown): IdentifierCase | undefined {
  const normalized = nonBlankString(value)?.toLowerCase() as IdentifierCase | undefined;
  return normalized && IDENTIFIER_CASES.has(normalized) ? normalized : undefined;
}

export function configuredDatabaseProductName(config: Pick<ConnectionConfig, "db_type" | "driver_label">): string {
  return config.driver_label?.trim() || config.db_type;
}

export function normalizeDatabaseConnectionInfo(value: unknown, fallbackProductName?: string, fallbackCurrentDatabase?: string): DatabaseConnectionInfo | undefined {
  const source = isRecord(value) ? value : {};
  const result: DatabaseConnectionInfo = {
    productName: nonBlankString(source.productName) ?? nonBlankString(fallbackProductName),
    productVersion: nonBlankString(source.productVersion),
    currentDatabase: nonBlankString(source.currentDatabase) ?? nonBlankString(fallbackCurrentDatabase),
    serverComment: nonBlankString(source.serverComment),
    serverCharset: nonBlankString(source.serverCharset),
    serverCollation: nonBlankString(source.serverCollation),
    unquotedIdentifierCase: identifierCase(source.unquotedIdentifierCase),
    quotedIdentifierCase: identifierCase(source.quotedIdentifierCase),
    driverName: nonBlankString(source.driverName),
    driverVersion: nonBlankString(source.driverVersion),
    jdbcVersion: nonBlankString(source.jdbcVersion),
  };
  return DATABASE_INFO_FIELDS.some((key) => result[key] !== undefined) ? result : undefined;
}

export function normalizeConnectionTestResult(value: unknown, config: ConnectionConfig): ConnectionTestResult {
  const fallbackProductName = configuredDatabaseProductName(config);
  const fallbackCurrentDatabase = config.database;
  if (typeof value === "string") {
    return {
      message: value,
      databaseInfo: normalizeDatabaseConnectionInfo(undefined, fallbackProductName, fallbackCurrentDatabase),
    };
  }
  if (!isRecord(value) || typeof value.message !== "string") {
    throw new Error("Invalid connection test response");
  }
  return {
    message: value.message,
    databaseInfo: normalizeDatabaseConnectionInfo(value.databaseInfo, fallbackProductName, fallbackCurrentDatabase),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) result[key] = stableValue(child);
  }
  return result;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function connectionConfigFingerprint(config: ConnectionConfig, sourceName = config.name): string {
  const { database_info: _databaseInfo, ...submittedConfig } = config;
  const serialized = JSON.stringify(stableValue({ config: submittedConfig, sourceName }));
  const first = fnv1a(serialized, 0x811c9dc5).toString(16).padStart(8, "0");
  const second = fnv1a(serialized, 0x9e3779b9).toString(16).padStart(8, "0");
  return `${first}${second}`;
}

export function databaseInfoRows(info: DatabaseConnectionInfo): DatabaseInfoRow[] {
  return DATABASE_INFO_FIELDS.flatMap((key) => {
    const value = info[key];
    return value ? [{ key, value }] : [];
  });
}

export function databaseInfoSummary(info: DatabaseConnectionInfo): string {
  return [info.productName, info.productVersion].filter(Boolean).join(" ");
}

export function databaseInfoCopyText(info: DatabaseConnectionInfo, fieldLabel: (field: DatabaseInfoField) => string, caseLabel: (value: IdentifierCase) => string): string {
  return databaseInfoRows(info)
    .map((row) => {
      const value = row.key === "unquotedIdentifierCase" || row.key === "quotedIdentifierCase" ? caseLabel(row.value as IdentifierCase) : row.value;
      return `${fieldLabel(row.key)}: ${value}`;
    })
    .join("\n");
}

export function isTauriCommandUnavailable(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`unknown command\\s*[:=]?\\s*['"]?${escapedCommand}['"]?`, "i").test(message) || new RegExp(`command\\s+['"]?${escapedCommand}['"]?\\s+(?:was\\s+)?not found`, "i").test(message);
}
