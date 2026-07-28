import { formatError } from "@/lib/backend/errorUtils";

export interface MysqlExplainCompatibilityHint {
  fallbackSql?: string;
  supportsJson: boolean;
}

const INVALID_EXPLAIN_OPTION_RE = /invalid\s+explain\s+option/i;
const VALID_EXPLAIN_OPTIONS_RE = /valid\s+options\s+are\s*:\s*\[([^\]]+)\]/i;
const EXPLAIN_FORMAT_PREFIX_RE = /^EXPLAIN\s+FORMAT\s*=\s*[A-Z_]+\s+/i;

export function mysqlExplainCompatibilityHint(error: unknown, explainSql: string): MysqlExplainCompatibilityHint | undefined {
  const message = formatError(error);
  if (!INVALID_EXPLAIN_OPTION_RE.test(message)) return undefined;

  const optionsMatch = message.match(VALID_EXPLAIN_OPTIONS_RE);
  if (!optionsMatch) return undefined;

  const validFormats = new Set(
    optionsMatch[1]
      .split(",")
      .map((format) =>
        format
          .trim()
          .replace(/^['"`]|['"`]$/g, "")
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const formatPrefixMatch = explainSql.match(EXPLAIN_FORMAT_PREFIX_RE);
  if (!formatPrefixMatch) return { supportsJson: validFormats.has("JSON") };

  // MySQL-compatible warehouses often expose TEXT as their tabular EXPLAIN format instead of TRADITIONAL.
  const fallbackPrefix = validFormats.has("TEXT") ? "EXPLAIN FORMAT=TEXT " : "EXPLAIN ";
  const fallbackSql = explainSql.replace(EXPLAIN_FORMAT_PREFIX_RE, fallbackPrefix);
  return {
    fallbackSql: fallbackSql === explainSql ? undefined : fallbackSql,
    supportsJson: validFormats.has("JSON"),
  };
}
