const option = "DBX_LEGACY_CHARSET";

export const ORACLE_LEGACY_CHARSETS = ["ZHS16GBK", "ZHS32GB18030", "AL32UTF8", "ZHT16MSWIN950"] as const;

export function oracleLegacyCharset(urlParams?: string): string {
  const values = new URLSearchParams(urlParams?.replace(/^\?/, ""));
  for (const [key, value] of values) {
    if (key.trim().toUpperCase() === option) return value.trim().toUpperCase();
  }
  return "";
}

export function withOracleLegacyCharset(urlParams: string | undefined, charset: string): string {
  const values = new URLSearchParams(urlParams?.replace(/^\?/, ""));
  for (const key of Array.from(values.keys())) {
    if (key.trim().toUpperCase() === option) values.delete(key);
  }
  if (charset) values.set(option, charset);
  return values.toString();
}
