import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

/** Remove only known OceanBase table storage options, keeping the cached source intact. */
export function applyDdlStoragePreference(sql: string, databaseType: DatabaseType | undefined, excludeStorage = true): string {
  if (databaseType !== "oceanbase-oracle" || !excludeStorage) return sql;
  const tokens = tokenizeSqlSemantic(sql, "oracle");
  if (tokens.some((token) => token.closed === false)) return sql;
  const removals: Array<{ start: number; end: number }> = [];
  let table = false;
  let options = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.depth !== 0) continue;
    if (token.text === ";") {
      table = options = false;
      continue;
    }
    if (token.kind === "word" && token.normalized === "create") {
      const offset = tokens[i + 1]?.normalized === "global" && tokens[i + 2]?.normalized === "temporary" ? 3 : 1;
      table = tokens[i + offset]?.normalized === "table";
      options = false;
    }
    if (!table) continue;
    if (token.text === ")") options = true;
    if (!options || token.kind !== "word") continue;
    // Partition expressions and bounds must never be treated as table options.
    if (token.normalized === "partition") {
      table = options = false;
      continue;
    }
    let last = i;
    if (token.normalized === "compress" && tokens[i + 1]?.normalized === "for" && tokens[i + 2]?.normalized === "archive") {
      last = i + 2;
      if (["high", "low"].includes(tokens[last + 1]?.normalized ?? "")) last++;
    } else if (token.normalized === "nocompress") {
      last = i;
    } else if (["replica_num", "block_size", "tablet_size", "pctfree", "use_bloom_filter"].includes(token.normalized)) {
      const valueIndex = tokens[i + 1]?.text === "=" ? i + 2 : i + 1;
      const value = tokens[valueIndex];
      const valid = token.normalized === "use_bloom_filter" ? value?.kind === "word" && ["true", "false"].includes(value.normalized) : value?.kind === "number" && /^\d+$/.test(value.text);
      if (!valid) continue;
      last = valueIndex;
    } else continue;
    removals.push({ start: token.span.start, end: tokens[last]!.span.end });
    i = last;
  }
  let result = sql;
  for (const { start, end } of removals.reverse()) result = result.slice(0, start) + result.slice(end);
  return result;
}
