import type { FieldMappingEntry } from "@/types/schemaDiff";

export interface FieldMappingPreset {
  id: string;
  label: string;
  sourceDialect: string;
  targetDialect: string;
  mappings: FieldMappingEntry[];
}

export const FIELD_MAPPING_PRESETS: FieldMappingPreset[] = [
  {
    id: "mysql-to-dameng",
    label: "MySQL → 达梦 (DM)",
    sourceDialect: "mysql",
    targetDialect: "dameng",
    mappings: [
      { sourceType: "VARCHAR", targetType: "VARCHAR", paramStrategy: "preserve" },
      { sourceType: "CHAR", targetType: "CHAR", paramStrategy: "preserve" },
      { sourceType: "TEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "TINYTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "MEDIUMTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "LONGTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "INT", targetType: "INT", paramStrategy: "preserve" },
      { sourceType: "BIGINT", targetType: "BIGINT", paramStrategy: "preserve" },
      { sourceType: "DECIMAL", targetType: "NUMERIC", paramStrategy: "preserve" },
      { sourceType: "FLOAT", targetType: "FLOAT", paramStrategy: "preserve" },
      { sourceType: "DOUBLE", targetType: "DOUBLE", paramStrategy: "preserve" },
      { sourceType: "DATE", targetType: "DATE", paramStrategy: "preserve" },
      { sourceType: "DATETIME", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "TIMESTAMP", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "BLOB", targetType: "BLOB", paramStrategy: "strip" },
      { sourceType: "JSON", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "TINYINT", targetType: "TINYINT", paramStrategy: "preserve" },
      { sourceType: "SMALLINT", targetType: "SMALLINT", paramStrategy: "preserve" },
      { sourceType: "BOOLEAN", targetType: "BOOLEAN", paramStrategy: "preserve" },
    ],
  },
  {
    id: "mysql-to-postgresql",
    label: "MySQL → PostgreSQL",
    sourceDialect: "mysql",
    targetDialect: "postgresql",
    mappings: [
      { sourceType: "VARCHAR", targetType: "VARCHAR", paramStrategy: "preserve" },
      { sourceType: "CHAR", targetType: "CHAR", paramStrategy: "preserve" },
      { sourceType: "TEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "TINYTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "MEDIUMTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "LONGTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "INT", targetType: "INTEGER", paramStrategy: "preserve" },
      { sourceType: "BIGINT", targetType: "BIGINT", paramStrategy: "preserve" },
      { sourceType: "DECIMAL", targetType: "NUMERIC", paramStrategy: "preserve" },
      { sourceType: "FLOAT", targetType: "REAL", paramStrategy: "preserve" },
      { sourceType: "DOUBLE", targetType: "DOUBLE PRECISION", paramStrategy: "preserve" },
      { sourceType: "DATETIME", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "TIMESTAMP", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "BLOB", targetType: "BYTEA", paramStrategy: "strip" },
      { sourceType: "JSON", targetType: "JSONB", paramStrategy: "preserve" },
      { sourceType: "TINYINT", targetType: "SMALLINT", paramStrategy: "preserve" },
      { sourceType: "BOOLEAN", targetType: "BOOLEAN", paramStrategy: "preserve" },
    ],
  },
  {
    id: "mysql-to-oracle",
    label: "MySQL → Oracle",
    sourceDialect: "mysql",
    targetDialect: "oracle",
    mappings: [
      { sourceType: "VARCHAR", targetType: "VARCHAR2", paramStrategy: "preserve" },
      { sourceType: "CHAR", targetType: "CHAR", paramStrategy: "preserve" },
      { sourceType: "TEXT", targetType: "CLOB", paramStrategy: "strip" },
      { sourceType: "TINYTEXT", targetType: "CLOB", paramStrategy: "strip" },
      { sourceType: "MEDIUMTEXT", targetType: "CLOB", paramStrategy: "strip" },
      { sourceType: "LONGTEXT", targetType: "CLOB", paramStrategy: "strip" },
      { sourceType: "INT", targetType: "NUMBER", paramStrategy: "preserve" },
      { sourceType: "BIGINT", targetType: "NUMBER", paramStrategy: "preserve" },
      { sourceType: "DECIMAL", targetType: "NUMBER", paramStrategy: "preserve" },
      { sourceType: "FLOAT", targetType: "BINARY_FLOAT", paramStrategy: "preserve" },
      { sourceType: "DOUBLE", targetType: "BINARY_DOUBLE", paramStrategy: "preserve" },
      { sourceType: "DATETIME", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "TIMESTAMP", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "BLOB", targetType: "BLOB", paramStrategy: "strip" },
      { sourceType: "JSON", targetType: "CLOB", paramStrategy: "strip" },
      { sourceType: "BOOLEAN", targetType: "NUMBER(1)", paramStrategy: "custom", customParams: "(1)" },
    ],
  },
  {
    id: "sqlserver-to-postgresql",
    label: "SQL Server → PostgreSQL",
    sourceDialect: "sqlserver",
    targetDialect: "postgresql",
    mappings: [
      { sourceType: "VARCHAR", targetType: "VARCHAR", paramStrategy: "preserve" },
      { sourceType: "NVARCHAR", targetType: "VARCHAR", paramStrategy: "preserve" },
      { sourceType: "CHAR", targetType: "CHAR", paramStrategy: "preserve" },
      { sourceType: "NCHAR", targetType: "CHAR", paramStrategy: "preserve" },
      { sourceType: "TEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "NTEXT", targetType: "TEXT", paramStrategy: "strip" },
      { sourceType: "INT", targetType: "INTEGER", paramStrategy: "preserve" },
      { sourceType: "BIGINT", targetType: "BIGINT", paramStrategy: "preserve" },
      { sourceType: "SMALLINT", targetType: "SMALLINT", paramStrategy: "preserve" },
      { sourceType: "TINYINT", targetType: "SMALLINT", paramStrategy: "preserve" },
      { sourceType: "BIT", targetType: "BOOLEAN", paramStrategy: "strip" },
      { sourceType: "DECIMAL", targetType: "NUMERIC", paramStrategy: "preserve" },
      { sourceType: "NUMERIC", targetType: "NUMERIC", paramStrategy: "preserve" },
      { sourceType: "MONEY", targetType: "NUMERIC", paramStrategy: "strip" },
      { sourceType: "SMALLMONEY", targetType: "NUMERIC", paramStrategy: "strip" },
      { sourceType: "FLOAT", targetType: "DOUBLE PRECISION", paramStrategy: "strip" },
      { sourceType: "REAL", targetType: "REAL", paramStrategy: "strip" },
      { sourceType: "DATE", targetType: "DATE", paramStrategy: "preserve" },
      { sourceType: "DATETIME", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "DATETIME2", targetType: "TIMESTAMP", paramStrategy: "preserve" },
      { sourceType: "SMALLDATETIME", targetType: "TIMESTAMP", paramStrategy: "strip" },
      { sourceType: "DATETIMEOFFSET", targetType: "TIMESTAMPTZ", paramStrategy: "preserve" },
      { sourceType: "TIME", targetType: "TIME", paramStrategy: "preserve" },
      { sourceType: "UNIQUEIDENTIFIER", targetType: "UUID", paramStrategy: "strip" },
      { sourceType: "VARBINARY", targetType: "BYTEA", paramStrategy: "strip" },
      { sourceType: "BINARY", targetType: "BYTEA", paramStrategy: "strip" },
      { sourceType: "IMAGE", targetType: "BYTEA", paramStrategy: "strip" },
      { sourceType: "XML", targetType: "XML", paramStrategy: "strip" },
    ],
  },
];

function normalizeDialect(dialect: string): string {
  const d = dialect.trim().toLowerCase();
  if (d === "postgres" || d === "postgresql") return "postgresql";
  if (d === "sqlserver" || d === "mssql") return "sqlserver";
  return d;
}

export function findPreset(sourceDialect: string, targetDialect: string): FieldMappingPreset | undefined {
  const src = normalizeDialect(sourceDialect);
  const tgt = normalizeDialect(targetDialect);

  // Look for exact forward match
  const forward = FIELD_MAPPING_PRESETS.find((p) => p.sourceDialect === src && p.targetDialect === tgt);
  if (forward) return forward;

  // Look for reverse match and auto-generate bidirectional preset
  const reverse = FIELD_MAPPING_PRESETS.find((p) => p.sourceDialect === tgt && p.targetDialect === src);
  if (reverse) {
    return {
      id: `${reverse.id}-reverse`,
      label: `${reverse.label.split(" → ").reverse().join(" → ")}`,
      sourceDialect,
      targetDialect,
      mappings: reverse.mappings.map((m) => ({
        sourceType: m.targetType,
        targetType: m.sourceType,
        paramStrategy: m.paramStrategy === "custom" ? "strip" : m.paramStrategy,
      })),
    };
  }

  return undefined;
}
