import type { ColumnInfo, IndexInfo, DatabaseType } from "@/types/database";

export interface ColumnDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ColumnInfo;
  target?: ColumnInfo;
  changes?: string[];
}

export interface IndexDiff {
  type: "added" | "removed";
  name: string;
  source?: IndexInfo;
  target?: IndexInfo;
}

export interface TableDiff {
  type: "added" | "removed" | "modified";
  name: string;
  columns?: ColumnDiff[];
  indexes?: IndexDiff[];
  ddl?: string;
}

export function diffColumns(
  source: ColumnInfo[],
  target: ColumnInfo[],
): ColumnDiff[] {
  const diffs: ColumnDiff[] = [];
  const targetMap = new Map(target.map((c) => [c.name, c]));
  const sourceMap = new Map(source.map((c) => [c.name, c]));

  for (const sc of source) {
    const tc = targetMap.get(sc.name);
    if (!tc) {
      diffs.push({ type: "added", name: sc.name, source: sc });
    } else {
      const changes: string[] = [];
      if (sc.data_type.toLowerCase() !== tc.data_type.toLowerCase()) {
        changes.push(`type: ${tc.data_type} → ${sc.data_type}`);
      }
      if (sc.is_nullable !== tc.is_nullable) {
        changes.push(`nullable: ${tc.is_nullable ? "YES" : "NO"} → ${sc.is_nullable ? "YES" : "NO"}`);
      }
      if ((sc.column_default ?? "") !== (tc.column_default ?? "")) {
        changes.push(`default: ${tc.column_default ?? "NULL"} → ${sc.column_default ?? "NULL"}`);
      }
      if (changes.length > 0) {
        diffs.push({ type: "modified", name: sc.name, source: sc, target: tc, changes });
      }
    }
  }

  for (const tc of target) {
    if (!sourceMap.has(tc.name)) {
      diffs.push({ type: "removed", name: tc.name, target: tc });
    }
  }

  return diffs;
}

export function diffIndexes(
  source: IndexInfo[],
  target: IndexInfo[],
): IndexDiff[] {
  const diffs: IndexDiff[] = [];
  const targetMap = new Map(target.map((i) => [i.name, i]));
  const sourceMap = new Map(source.map((i) => [i.name, i]));

  for (const si of source) {
    if (si.is_primary) continue;
    if (!targetMap.has(si.name)) {
      diffs.push({ type: "added", name: si.name, source: si });
    }
  }

  for (const ti of target) {
    if (ti.is_primary) continue;
    if (!sourceMap.has(ti.name)) {
      diffs.push({ type: "removed", name: ti.name, target: ti });
    }
  }

  return diffs;
}

export function diffTables(
  sourceTables: string[],
  targetTables: string[],
): { added: string[]; removed: string[]; common: string[] } {
  const targetSet = new Set(targetTables);
  const sourceSet = new Set(sourceTables);
  return {
    added: sourceTables.filter((t) => !targetSet.has(t)),
    removed: targetTables.filter((t) => !sourceSet.has(t)),
    common: sourceTables.filter((t) => targetSet.has(t)),
  };
}

function quoteId(name: string, dbType: DatabaseType): string {
  if (dbType === "mysql" || dbType === "doris" || dbType === "starrocks") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function columnDef(col: ColumnInfo, dbType: DatabaseType): string {
  let def = `${quoteId(col.name, dbType)} ${col.data_type}`;
  if (!col.is_nullable) def += " NOT NULL";
  if (col.column_default !== null && col.column_default !== undefined) {
    def += ` DEFAULT ${col.column_default}`;
  }
  return def;
}

export function generateSyncSql(
  diffs: TableDiff[],
  dbType: DatabaseType,
): string {
  const lines: string[] = [];
  const isMySQL = dbType === "mysql" || dbType === "doris" || dbType === "starrocks";

  for (const diff of diffs) {
    const qt = quoteId(diff.name, dbType);

    if (diff.type === "added" && diff.ddl) {
      lines.push(`-- Create table: ${diff.name}`);
      lines.push(diff.ddl + ";");
      lines.push("");
      continue;
    }

    if (diff.type === "removed") {
      lines.push(`-- Drop table: ${diff.name}`);
      lines.push(`DROP TABLE IF EXISTS ${qt};`);
      lines.push("");
      continue;
    }

    if (diff.type === "modified") {
      const parts: string[] = [];

      if (diff.columns) {
        for (const col of diff.columns) {
          if (col.type === "added" && col.source) {
            parts.push(`  ADD COLUMN ${columnDef(col.source, dbType)}`);
          } else if (col.type === "removed") {
            parts.push(`  DROP COLUMN ${quoteId(col.name, dbType)}`);
          } else if (col.type === "modified" && col.source) {
            if (isMySQL) {
              parts.push(`  MODIFY COLUMN ${columnDef(col.source, dbType)}`);
            } else {
              const qn = quoteId(col.name, dbType);
              if (col.changes?.some((c) => c.startsWith("type:"))) {
                parts.push(`  ALTER COLUMN ${qn} TYPE ${col.source.data_type}`);
              }
              if (col.changes?.some((c) => c.startsWith("nullable:"))) {
                parts.push(
                  col.source.is_nullable
                    ? `  ALTER COLUMN ${qn} DROP NOT NULL`
                    : `  ALTER COLUMN ${qn} SET NOT NULL`,
                );
              }
              if (col.changes?.some((c) => c.startsWith("default:"))) {
                if (col.source.column_default !== null && col.source.column_default !== undefined) {
                  parts.push(`  ALTER COLUMN ${qn} SET DEFAULT ${col.source.column_default}`);
                } else {
                  parts.push(`  ALTER COLUMN ${qn} DROP DEFAULT`);
                }
              }
            }
          }
        }
      }

      if (diff.indexes) {
        for (const idx of diff.indexes) {
          if (idx.type === "added" && idx.source) {
            const cols = idx.source.columns.map((c) => quoteId(c, dbType)).join(", ");
            const unique = idx.source.is_unique ? "UNIQUE " : "";
            lines.push(`CREATE ${unique}INDEX ${quoteId(idx.name, dbType)} ON ${qt} (${cols});`);
          } else if (idx.type === "removed") {
            if (isMySQL) {
              lines.push(`DROP INDEX ${quoteId(idx.name, dbType)} ON ${qt};`);
            } else {
              lines.push(`DROP INDEX IF EXISTS ${quoteId(idx.name, dbType)};`);
            }
          }
        }
      }

      if (parts.length > 0) {
        lines.push(`-- Alter table: ${diff.name}`);
        if (isMySQL) {
          lines.push(`ALTER TABLE ${qt}`);
          lines.push(parts.join(",\n") + ";");
        } else {
          for (const part of parts) {
            lines.push(`ALTER TABLE ${qt}${part};`);
          }
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n").trim();
}
