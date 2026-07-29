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
];

export function findPreset(sourceDialect: string, targetDialect: string): FieldMappingPreset | undefined {
  // Look for exact forward match
  const forward = FIELD_MAPPING_PRESETS.find((p) => p.sourceDialect === sourceDialect && p.targetDialect === targetDialect);
  if (forward) return forward;

  // Look for reverse match and auto-generate bidirectional preset
  const reverse = FIELD_MAPPING_PRESETS.find((p) => p.sourceDialect === targetDialect && p.targetDialect === sourceDialect);
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
