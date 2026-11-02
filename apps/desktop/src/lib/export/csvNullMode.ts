/**
 * 导出 CSV 时 NULL 的写法。与 Rust `dbx_formats::csv_export` 保持一致：
 * `marker` 把 NULL 写成 `\N`（MySQL `SELECT ... INTO OUTFILE`、ClickHouse
 * `format_csv_null_representation` 的既定写法），空字符串才写成空字段，两者在文件里可区分，
 * 导回 NOT NULL DEFAULT '' 的列时不会被还原成 NULL；`empty` 是旧行为：NULL 与空字符串都写成空字段。
 */
export const DEFAULT_CSV_NULL_LITERAL = "\\N";

export const CSV_NULL_MODE_MARKER = "marker";
export const CSV_NULL_MODE_EMPTY = "empty";

export type CsvNullMode = typeof CSV_NULL_MODE_MARKER | typeof CSV_NULL_MODE_EMPTY;

export const DEFAULT_CSV_NULL_MODE: CsvNullMode = CSV_NULL_MODE_MARKER;

export function normalizeCsvNullMode(value: unknown): CsvNullMode {
  return value === CSV_NULL_MODE_EMPTY ? CSV_NULL_MODE_EMPTY : DEFAULT_CSV_NULL_MODE;
}

/** 导出请求里的 NULL 字面量；空串表示关闭该字面量（旧行为）。 */
export function csvNullLiteralForMode(mode: CsvNullMode): string {
  return mode === CSV_NULL_MODE_EMPTY ? "" : DEFAULT_CSV_NULL_LITERAL;
}
