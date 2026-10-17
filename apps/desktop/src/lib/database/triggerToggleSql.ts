import type { DatabaseType } from "@/types/database";

export interface TriggerToggleSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  triggerName: string;
  enabled: boolean;
}

const SUPPORTED_TRIGGER_TOGGLE_DATABASES = new Set<DatabaseType>(["sqlserver", "oracle", "oceanbase-oracle", "dameng", "postgres", "kingbase", "opengauss", "vastbase", "highgo", "uxdb", "gaussdb", "kwdb", "xugu"]);

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

    default:
      return null;
  }
}
