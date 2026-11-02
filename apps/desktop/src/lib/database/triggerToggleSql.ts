import type { DatabaseType, OracleTriggerMetadata } from "@/types/database";
import { quoteOracleLiteral } from "@/lib/database/oracleInvalidObjects";

export interface TriggerToggleSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  triggerName: string;
  enabled: boolean;
  identityMode?: "exact";
  scope?: OracleTriggerMetadata["scope"];
}

const SUPPORTED_TRIGGER_TOGGLE_DATABASES = new Set<DatabaseType>(["sqlserver", "oracle", "oceanbase-oracle", "dameng", "postgres", "kingbase", "opengauss", "vastbase", "highgo", "uxdb", "gaussdb", "kwdb", "xugu", "firebird"]);

export function supportsTriggerToggle(databaseType?: DatabaseType): boolean {
  if (!databaseType) return false;
  return SUPPORTED_TRIGGER_TOGGLE_DATABASES.has(databaseType);
}

function quoteSqlServer(name: string): string {
  return `[${name.replaceAll("]", "]]")}]`;
}

function quoteDouble(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function buildTriggerToggleSql(options: TriggerToggleSqlOptions): string | null {
  const { databaseType, schema, tableName, triggerName, enabled } = options;
  if (options.identityMode === "exact") {
    if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle" && databaseType !== "dameng") return null;
    if (!schema?.length || !triggerName.length || schema.includes("\0") || triggerName.includes("\0")) return null;
    const relation = options.scope === "TABLE" || options.scope === "VIEW";
    const event = options.scope === "SCHEMA" || options.scope === "DATABASE" || options.scope === "TIMER";
    if ((!relation && !event) || (databaseType === "oceanbase-oracle" && !relation) || (databaseType === "oracle" && options.scope === "TIMER")) return null;
    if (databaseType === "dameng" && event) return `SP_ENABLE_EVT_TRIGGER(${quoteOracleLiteral(schema)}, ${quoteOracleLiteral(triggerName)}, ${enabled ? 1 : 0});`;
    return `ALTER TRIGGER ${quoteDouble(schema)}.${quoteDouble(triggerName)} ${enabled ? "ENABLE" : "DISABLE"};`;
  }
  const cleanTrigger = triggerName.trim();
  if (!cleanTrigger || !databaseType || !supportsTriggerToggle(databaseType)) return null;

  const stateKeyword = enabled ? "ENABLE" : "DISABLE";
  const cleanSchema = schema?.trim();
  const cleanTable = tableName?.trim();

  switch (databaseType) {
    case "sqlserver": {
      const quotedTrigger = cleanSchema ? `${quoteSqlServer(cleanSchema)}.${quoteSqlServer(cleanTrigger)}` : quoteSqlServer(cleanTrigger);
      if (cleanTable) {
        const quotedTable = cleanSchema ? `${quoteSqlServer(cleanSchema)}.${quoteSqlServer(cleanTable)}` : quoteSqlServer(cleanTable);
        return `${stateKeyword} TRIGGER ${quotedTrigger} ON ${quotedTable};`;
      }
      return `${stateKeyword} TRIGGER ${quotedTrigger} ON DATABASE;`;
    }

    case "oracle":
    case "oceanbase-oracle":
    case "dameng":
    case "xugu": {
      const quotedTrigger = cleanSchema ? `${quoteDouble(cleanSchema)}.${quoteDouble(cleanTrigger)}` : quoteDouble(cleanTrigger);
      return `ALTER TRIGGER ${quotedTrigger} ${stateKeyword};`;
    }

    case "postgres":
    case "kingbase":
    case "opengauss":
    case "vastbase":
    case "highgo":
    case "uxdb":
    case "gaussdb":
    case "kwdb": {
      if (!cleanTable) return null;
      const quotedTable = cleanSchema ? `${quoteDouble(cleanSchema)}.${quoteDouble(cleanTable)}` : quoteDouble(cleanTable);
      const quotedTrigger = quoteDouble(cleanTrigger);
      return `ALTER TABLE ${quotedTable} ${stateKeyword} TRIGGER ${quotedTrigger};`;
    }

    case "firebird": {
      const quotedTrigger = quoteDouble(cleanTrigger);
      return `ALTER TRIGGER ${quotedTrigger} ${enabled ? "ACTIVE" : "INACTIVE"};`;
    }

    default:
      return null;
  }
}
