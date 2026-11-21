import type { ColumnGenerateConfig, TableGenerateConfig } from "./dataGenerate";

export class MysqlGeneratePartitionError extends Error {
  constructor(
    public table: string,
    public expression: string,
  ) {
    super(`Cannot safely generate partition values for ${table} (${expression}). Check the partition definition and generator settings.`);
  }
}

export interface MysqlGeneratePartition {
  method: string;
  expression: string;
  description: string;
}

/** Hex literals avoid SQL-mode-dependent escaping of catalog identifiers. */
export function mysqlGeneratePartitionQuery(schema: string, table: string): string {
  const literal = (value: string) => `CONVERT(X'${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("")}' USING utf8mb4)`;
  return `SELECT PARTITION_METHOD, PARTITION_EXPRESSION, PARTITION_DESCRIPTION FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ${literal(schema)} AND TABLE_NAME = ${literal(table)} AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION`;
}

/** Apply partition constraints to a copy, shared by preview and streamed inserts.
 * HASH/KEY cover every value. RANGE bounds are exclusive; LIST values may have
 * gaps, so a min/max approximation would still produce ERROR 1526 (#13883).
 */
export function constrainMysqlGenerateColumns(config: TableGenerateConfig, partitions: MysqlGeneratePartition[]): ColumnGenerateConfig[] {
  const bounded = partitions.filter((p) => /^(RANGE|LIST)( COLUMNS)?$/i.test(p.method));
  if (bounded.length === 0) return config.columns;
  if (/^RANGE/i.test(bounded[0]!.method) && bounded.some((p) => p.description.toUpperCase() === "MAXVALUE")) return config.columns;
  const expression = bounded[0]!.expression.trim();
  const dateFunction = /^(YEAR|TO_DAYS|UNIX_TIMESTAMP)\s*\(\s*(`(?:``|[^`])+`|[\w$]+)\s*\)$/i.exec(expression);
  const identifier = dateFunction?.[2] ?? expression;
  const key = identifier.startsWith("`") && identifier.endsWith("`") ? identifier.slice(1, -1).replace(/``/g, "`") : identifier;
  const column = config.columns.find((c) => c.columnName.toLowerCase() === key.toLowerCase());
  const fail = (): never => {
    throw new MysqlGeneratePartitionError(config.tableName, expression);
  };
  // Resolve only known single-column expressions; never guess tuple boundaries.
  if (!column) return fail();
  const params = { ...column.generatorParams };
  let generatorKey = column.generatorKey;
  if (/^(date|datetime|timestamp)\b/i.test(column.dataType) && /^RANGE/i.test(bounded[0]!.method)) {
    if (generatorKey !== "date" && generatorKey !== "datetime") return fail();
    const boundaries = bounded.map((p) => {
      if (!dateFunction) {
        const match = /^'(\d{4}-\d{2}-\d{2})(?:[ T][\d:.]+)?'$/.exec(p.description);
        return match ? Date.parse(`${match[1]}T00:00:00Z`) : NaN;
      }
      if (!/^\d+$/.test(p.description)) return NaN;
      const n = Number(p.description);
      switch (dateFunction[1]!.toUpperCase()) {
        case "YEAR":
          return n >= 100 && n <= 9999 ? Date.UTC(n, 0, 1) : NaN;
        // TO_DAYS('1970-01-01') = 719528; MySQL counts from year zero.
        case "TO_DAYS":
          return (n - 719528) * 86400000;
        case "UNIX_TIMESTAMP":
          return n * 1000;
        default:
          return NaN;
      }
    });
    if (boundaries.some((n) => !Number.isFinite(n))) return fail();
    // The datetime generator adds a random time of day. Use the preceding
    // calendar day so even its latest time stays below the exclusive bound.
    const cutoff = new Date(Math.max(...boundaries) - (dateFunction?.[1]?.toUpperCase() === "UNIX_TIMESTAMP" ? 2 : 1) * 86400000);
    if (!Number.isFinite(cutoff.getTime()) || cutoff.getUTCFullYear() < 1000 || cutoff.getUTCFullYear() > 9999) return fail();
    const end = cutoff.toISOString().slice(0, 10);
    params.end = params.end && params.end < end ? params.end : end;
    params.start = params.start ?? "2020-01-01";
    if (params.start > params.end) params.start = params.end;
    params.allDay = true;
  } else if (!/^(tinyint|smallint|mediumint|int|integer|bigint)\b/i.test(column.dataType) || dateFunction) return fail();
  else if (/^LIST/i.test(bounded[0]!.method)) {
    const tokens = bounded.flatMap((p) => p.description.split(",").map((s) => s.trim())).filter((s) => s.toUpperCase() !== "NULL");
    if (!tokens.length || tokens.some((s) => !/^-?\d+$/.test(s) || !Number.isSafeInteger(Number(s)))) return fail();
    const allowed = new Set(tokens.map(Number));
    if (generatorKey === "sequence") {
      const start = params.startValue ?? 1;
      const increment = params.increment ?? 1;
      if (config.rowCount > allowed.size && increment !== 0) return fail();
      const count = increment === 0 ? Math.min(config.rowCount, 1) : config.rowCount;
      for (let i = 0; i < count; i++) if (!allowed.has(start + i * increment)) return fail();
    } else {
      generatorKey = "enum";
      params.values = [...allowed].join("\n");
    }
  } else {
    const limits = bounded.map((p) => Number(p.description));
    if (bounded.some((p) => !/^-?\d+$/.test(p.description)) || limits.some((n) => !Number.isSafeInteger(n))) return fail();
    const max = Math.max(...limits) - 1;
    if (!Number.isSafeInteger(max)) return fail();
    if (generatorKey === "sequence") {
      const start = params.startValue ?? 1;
      const last = start + Math.max(0, config.rowCount - 1) * (params.increment ?? 1);
      if (Math.max(start, last) > max) return fail();
    } else if (generatorKey === "number" || !generatorKey) {
      params.max = Math.min(params.max ?? max, max);
      if (/unsigned/i.test(column.dataType) && max < 0) return fail();
      params.min = Math.min(params.min ?? 1, params.max);
      params.numberType = "integer";
    } else return fail();
  }
  // Defaults and NULL must also satisfy the partition predicate; generate from
  // the constrained domain instead of substituting an unrelated schema default.
  params.includeDefault = false;
  params.includeNull = false;
  return config.columns.map((c) => (c === column ? { ...c, generatorKey, generatorParams: params } : c));
}
