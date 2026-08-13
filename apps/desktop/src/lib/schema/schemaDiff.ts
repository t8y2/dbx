import type { ColumnInfo, IndexInfo, ForeignKeyInfo, TriggerInfo, FunctionInfo, SequenceInfo, RuleInfo, OwnerInfo, DatabaseType, TableInfo } from "@/types/database";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";

const DIALECT_KIND_MAP: Record<string, string> = {
  mysql: "mysql",
  doris: "mysql",
  starrocks: "mysql",
  goldendb: "mysql",
  sundb: "mysql",
  databend: "mysql",
  gbase: "mysql",
  postgres: "postgres",
  gaussdb: "postgres",
  kwdb: "postgres",
  opengauss: "postgres",
  highgo: "postgres",
  vastbase: "postgres",
  kingbase: "postgres",
  firebird: "postgres",
  redshift: "postgres",
  vertica: "postgres",
  exasol: "postgres",
  sqlite: "sqlite",
  rqlite: "sqlite",
  turso: "sqlite",
  duckdb: "duckdb",
  sqlserver: "sql_server",
  access: "sql_server",
  oracle: "oracle",
  dameng: "oracle",
  "oceanbase-oracle": "oracle",
  iris: "oracle",
  yashandb: "oracle",
  xugu: "oracle",
  h2: "h2",
  clickhouse: "click_house",
  manticoresearch: "manticore_search",
  informix: "informix",
  questdb: "questdb",
};

export function databaseTypeToDialectKind(dbType: DatabaseType): string {
  return DIALECT_KIND_MAP[dbType] ?? "unsupported";
}

const DIALECT_ALIAS_MAP: Record<string, string> = {
  access: "sql_server",
  mssql: "sql_server",
  "sql server": "sql_server",
  postgresql: "postgres",
  sqlite3: "sqlite",
  "oceanbase-oracle": "oracle",
  oceanbase: "oracle",
  dameng: "oracle",
  iris: "oracle",
  yashandb: "oracle",
  xugu: "oracle",
  gaussdb: "postgres",
  kwdb: "postgres",
  opengauss: "postgres",
  highgo: "postgres",
  vastbase: "postgres",
  kingbase: "postgres",
  firebird: "postgres",
  redshift: "postgres",
  vertica: "postgres",
  exasol: "postgres",
  doris: "mysql",
  starrocks: "mysql",
  goldendb: "mysql",
  sundb: "mysql",
  databend: "mysql",
  gbase: "mysql",
  rqlite: "sqlite",
  turso: "sqlite",
  manticore: "manticore_search",
  questdb: "questdb",
  clickhouse: "click_house",
};

export function normalizeDialectKind(input: string): string {
  const lower = input.trim().toLowerCase();
  if (DIALECT_KIND_MAP[lower]) return DIALECT_KIND_MAP[lower];
  if (DIALECT_ALIAS_MAP[lower]) return DIALECT_ALIAS_MAP[lower];
  return lower;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : Math.min(prev[j], curr[j - 1], prev[j - 1]) + 1;
    }
    prev = curr;
  }
  return prev[n];
}

function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

export interface ColumnDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ColumnInfo;
  target?: ColumnInfo;
  changes?: string[];
  addPosition?: "first" | { after: string };
}

export interface IndexDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: IndexInfo;
  target?: IndexInfo;
  changes?: string[];
}

export interface ForeignKeyDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ForeignKeyInfo;
  target?: ForeignKeyInfo;
  changes?: string[];
}

export interface TriggerDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: TriggerInfo;
  target?: TriggerInfo;
  changes?: string[];
}

export interface FunctionDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: FunctionInfo;
  target?: FunctionInfo;
  changes?: string[];
}

export interface SequenceDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: SequenceInfo;
  target?: SequenceInfo;
  changes?: string[];
}

export interface RuleDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: RuleInfo;
  target?: RuleInfo;
  changes?: string[];
}

export interface OwnerDiff {
  type: "added" | "removed" | "modified";
  objectName: string;
  source?: OwnerInfo;
  target?: OwnerInfo;
  changes?: string[];
}

export interface TableDiff {
  type: "added" | "removed" | "modified" | "renamed";
  objectType?: "table" | "view";
  name: string;
  columns?: ColumnDiff[];
  indexes?: IndexDiff[];
  foreignKeys?: ForeignKeyDiff[];
  triggers?: TriggerDiff[];
  ddl?: string;
  targetDdl?: string;
  sourceTableComment?: string | null;
  targetTableComment?: string | null;
  syncSql?: string;
}

export interface TableSchemaDetail {
  name: string;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  triggers?: TriggerInfo[];
  ddl?: string;
}

export interface FieldMappingEntry {
  sourceType: string;
  targetType: string;
}

export interface SchemaDiffPreparationOptions {
  sourceTables: TableInfo[];
  targetTables: TableInfo[];
  sourceDetails: TableSchemaDetail[];
  targetDetails: TableSchemaDetail[];
  sourceFunctions?: FunctionInfo[];
  targetFunctions?: FunctionInfo[];
  sourceSequences?: SequenceInfo[];
  targetSequences?: SequenceInfo[];
  sourceRules?: RuleInfo[];
  targetRules?: RuleInfo[];
  sourceOwners?: OwnerInfo[];
  targetOwners?: OwnerInfo[];
  databaseType: DatabaseType;
  targetSchema?: string;
  ignoreComments?: boolean;
  cascadeDelete?: boolean;
  compareColumnOrder?: boolean;
  detectRenames?: boolean;
  detectTableRenames?: boolean;
  renameThreshold?: number;
  enableRollback?: boolean;
  batchPatterns?: string[];
  sourceDialect?: string;
  targetDialect?: string;
  compatibilityThreshold?: number;
  fieldMappings?: FieldMappingEntry[];
}

export interface RenameCandidate {
  sourceName: string;
  targetName: string;
  score: number;
}

export interface CompatibilityWarning {
  table: string;
  column: string;
  sourceType: string;
  targetType: string;
  risk: string;
  message: string;
}

export interface PermissionDiff {
  objectName: string;
  permissionType: string;
  sourcePermission: string | null;
  targetPermission: string | null;
}

export interface DependencyNode {
  tableName: string;
  dependsOn: string[];
  dependedBy: string[];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
}

export interface MissingRollbackObject {
  kind: string;
  name: string;
  table?: string;
  reason: string;
}

export type RollbackCompleteness = "complete" | "incomplete";

export interface SchemaDiffPreparation {
  diffs: TableDiff[];
  functionDiffs?: FunctionDiff[];
  sequenceDiffs?: SequenceDiff[];
  ruleDiffs?: RuleDiff[];
  ownerDiffs?: OwnerDiff[];
  syncSql: string;
  rollbackSyncSql?: string;
  rollbackCompleteness?: RollbackCompleteness;
  missingRollbackObjects?: MissingRollbackObject[];
  renameCandidates?: RenameCandidate[];
  rollbackGraph?: unknown;
  compatibilityWarnings?: CompatibilityWarning[];
  permissionDiffs?: PermissionDiff[];
  permissionSyncSql?: string;
  dependencyGraph?: DependencyGraph;
}

const MYSQL_LIKE_SCHEMA_DIFF_TARGET_TYPES = new Set<DatabaseType>(["mysql", "doris", "starrocks", "goldendb", "sundb", "databend", "gbase"]);

export function schemaDiffDeployTargetSchema(databaseType: DatabaseType | undefined, targetDatabase: string, targetSchema?: string): string | undefined {
  const schema = targetSchema?.trim();
  if (schema) return schema;

  const database = targetDatabase.trim();
  if (databaseType && MYSQL_LIKE_SCHEMA_DIFF_TARGET_TYPES.has(databaseType) && database) {
    return database;
  }

  return undefined;
}

// Unified object type for UI display
export type DiffOperationType = "modify" | "create" | "delete" | "none";
export type DiffObjectKind = "table" | "view" | "function" | "sequence" | "rule" | "owner" | "column" | "index" | "trigger" | "foreignKey";

export interface SchemaDiffObject {
  id: string;
  operationType: DiffOperationType;
  objectKind: DiffObjectKind;
  name: string;
  sourceName?: string;
  targetName?: string;
  selected: boolean;
  sourceDdl?: string;
  targetDdl?: string;
  deploySql?: string;
  rollbackDdl?: string;
  changes?: string[];
  children?: SchemaDiffObject[];
  parentId?: string;
  parentName?: string;
  /** Function arguments signature (for PostgreSQL overloaded functions) */
  arguments?: string;
  renameMetadata?: {
    confirmed: boolean;
    sourceName?: string;
    targetName?: string;
    score?: number;
  };
}

export interface SchemaDiffGroup {
  operationType: DiffOperationType;
  label: string;
  count: number;
  selectedCount: number;
  expanded: boolean;
  objects: SchemaDiffObject[];
}

export interface DestructiveSchemaDiffStatement {
  action: "drop" | "truncate";
  objectType: string;
  statement: string;
}

function stripSqlCommentsAndStringLiterals(sql: string): string {
  let result = "";
  let index = 0;
  let state: "plain" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "plain";

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (state === "line") {
      if (current === "\n") {
        state = "plain";
        result += "\n";
      } else {
        result += " ";
      }
      index++;
      continue;
    }

    if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        state = "plain";
        index += 2;
      } else {
        result += current === "\n" ? "\n" : " ";
        index++;
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "backtick") {
      result += current === "\n" ? "\n" : " ";
      const delimiter = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (current === delimiter && next === delimiter) {
        result += " ";
        index += 2;
      } else {
        if (current === delimiter) state = "plain";
        index++;
      }
      continue;
    }

    if (state === "bracket") {
      result += current === "\n" ? "\n" : " ";
      if (current === "]" && next === "]") {
        result += " ";
        index += 2;
      } else {
        if (current === "]") state = "plain";
        index++;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      result += "  ";
      state = "line";
      index += 2;
      continue;
    }
    if (current === "#") {
      result += " ";
      state = "line";
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      result += "  ";
      state = "block";
      index += 2;
      continue;
    }
    if (current === "'") {
      result += " ";
      state = "single";
      index++;
      continue;
    }
    if (current === '"') {
      result += " ";
      state = "double";
      index++;
      continue;
    }
    if (current === "`") {
      result += " ";
      state = "backtick";
      index++;
      continue;
    }
    if (current === "[") {
      result += " ";
      state = "bracket";
      index++;
      continue;
    }

    result += current;
    index++;
  }

  return result;
}

export function detectDestructiveSchemaDiffStatements(sql: string, databaseType?: DatabaseType): DestructiveSchemaDiffStatement[] {
  const statements = splitSqlStatementRanges(sql, databaseType);
  const destructive: DestructiveSchemaDiffStatement[] = [];

  for (const range of statements) {
    const statement = range.sql.trim().replace(/;\s*$/, "");
    const normalized = stripSqlCommentsAndStringLiterals(statement).trim();
    const topLevel = normalized.match(/^DROP\s+(?:TEMPORARY\s+)?(MATERIALIZED\s+VIEW|FOREIGN\s+TABLE|EVENT\s+TRIGGER|USER\s+MAPPING|OWNED\s+BY|[A-Z_]+)\b/i);
    if (topLevel) {
      destructive.push({ action: "drop", objectType: topLevel[1].toUpperCase(), statement });
      continue;
    }

    if (/^TRUNCATE\b/i.test(normalized)) {
      destructive.push({ action: "truncate", objectType: "TABLE", statement });
      continue;
    }

    if (/^ALTER\b/i.test(normalized)) {
      const dropClauses = normalized.matchAll(/\bDROP\s+(COLUMN|CONSTRAINT|INDEX|KEY|PRIMARY\s+KEY|FOREIGN\s+KEY|PARTITION|DEFAULT)\b/gi);
      for (const match of dropClauses) {
        destructive.push({ action: "drop", objectType: match[1].toUpperCase(), statement });
      }
    }
  }

  return destructive;
}

export function getOperationType(diffType: string): DiffOperationType {
  switch (diffType) {
    case "modified":
    case "renamed":
      return "modify";
    case "added":
      return "create";
    case "removed":
      return "delete";
    default:
      return "none";
  }
}

export function getOperationLabel(operationType: DiffOperationType): string {
  switch (operationType) {
    case "modify":
      return "diff.operationLabel.modify";
    case "create":
      return "diff.operationLabel.create";
    case "delete":
      return "diff.operationLabel.delete";
    case "none":
      return "diff.operationLabel.none";
  }
}

function buildSequenceDdl(seq: SequenceInfo): string {
  const parts = [`CREATE SEQUENCE ${seq.name}`];
  if (seq.data_type) parts.push(`    AS ${seq.data_type}`);
  if (seq.start_value != null) parts.push(`    START WITH ${seq.start_value}`);
  if (seq.increment != null) parts.push(`    INCREMENT BY ${seq.increment}`);
  if (seq.min_value != null) parts.push(`    MINVALUE ${seq.min_value}`);
  if (seq.max_value != null) parts.push(`    MAXVALUE ${seq.max_value}`);
  else parts.push(`    NO MAXVALUE`);
  parts.push(`    ${seq.cycle ? "" : "NO "}CYCLE`);
  parts.push(`;`);
  if (seq.last_value != null) {
    parts.push(`SELECT setval('${seq.name}', ${seq.last_value});`);
  }
  return parts.join("\n");
}

export function convertToSchemaDiffObjects(tableDiffs: TableDiff[], functionDiffs: FunctionDiff[] = [], sequenceDiffs: SequenceDiff[] = [], ruleDiffs: RuleDiff[] = [], ownerDiffs: OwnerDiff[] = [], renameCandidates?: RenameCandidate[]): SchemaDiffObject[] {
  const objects: SchemaDiffObject[] = [];

  for (const diff of tableDiffs) {
    const opType = getOperationType(diff.type);
    const isRenamed = diff.type === "renamed";
    const newName = isRenamed && renameCandidates ? (renameCandidates.find((rc) => rc.sourceName === diff.name)?.targetName ?? diff.name) : undefined;

    const obj: SchemaDiffObject = {
      id: `table-${diff.name}`,
      operationType: opType,
      objectKind: diff.objectType === "view" ? "view" : "table",
      name: diff.name,
      sourceName: diff.type === "added" ? undefined : diff.name,
      targetName: diff.type === "removed" ? undefined : isRenamed ? newName : diff.name,
      selected: opType !== "none",
      sourceDdl: diff.ddl,
      targetDdl: diff.targetDdl,
      deploySql: isRenamed && newName ? (diff.objectType === "view" ? `ALTER VIEW ${diff.name} RENAME TO ${newName};` : `RENAME TABLE ${diff.name} TO ${newName};`) : diff.syncSql,
      changes: diff.columns?.flatMap((c) => c.changes || []),
      renameMetadata: isRenamed && newName ? { confirmed: true, sourceName: diff.name, targetName: newName, score: renameCandidates?.find((rc) => rc.sourceName === diff.name)?.score } : undefined,
      children: [
        ...(diff.columns?.map((c) => ({
          id: `col-${diff.name}-${c.name}`,
          operationType: getOperationType(c.type),
          objectKind: "column" as DiffObjectKind,
          name: c.name,
          sourceName: c.type === "added" ? undefined : c.name,
          targetName: c.type === "removed" ? undefined : c.name,
          selected: opType !== "none",
          changes: c.changes,
          parentId: `table-${diff.name}`,
          parentName: diff.name,
        })) || []),
        ...(diff.indexes?.map((i) => ({
          id: `idx-${diff.name}-${i.name}`,
          // A modified index is implemented as DROP + CREATE by the backend.
          // Surface the destructive half in the delete group instead of hiding it under table modification.
          operationType: i.type === "modified" ? ("delete" as DiffOperationType) : getOperationType(i.type),
          objectKind: "index" as DiffObjectKind,
          name: i.name,
          sourceName: i.type === "added" ? undefined : i.name,
          targetName: i.type === "removed" ? undefined : i.name,
          selected: opType !== "none",
          changes: i.changes,
          parentId: `table-${diff.name}`,
          parentName: diff.name,
        })) || []),
        ...(diff.foreignKeys?.map((f) => ({
          id: `fk-${diff.name}-${f.name}`,
          // Modified foreign keys are also dropped before they are recreated.
          operationType: f.type === "modified" ? ("delete" as DiffOperationType) : getOperationType(f.type),
          objectKind: "foreignKey" as DiffObjectKind,
          name: f.name,
          sourceName: f.type === "added" ? undefined : f.name,
          targetName: f.type === "removed" ? undefined : f.name,
          selected: opType !== "none",
          changes: f.changes,
          parentId: `table-${diff.name}`,
          parentName: diff.name,
        })) || []),
        ...(diff.triggers?.map((t) => ({
          id: `trg-${diff.name}-${t.name}`,
          operationType: getOperationType(t.type),
          objectKind: "trigger" as DiffObjectKind,
          name: t.name,
          sourceName: t.type === "added" ? undefined : t.name,
          targetName: t.type === "removed" ? undefined : t.name,
          selected: opType !== "none",
          changes: t.changes,
          parentId: `table-${diff.name}`,
          parentName: diff.name,
        })) || []),
      ],
    };
    objects.push(obj);
  }

  for (const diff of functionDiffs) {
    const args = diff.source?.arguments || diff.target?.arguments || "";
    objects.push({
      id: `func-${diff.name}-${args}`,
      operationType: getOperationType(diff.type),
      objectKind: "function",
      name: diff.name,
      arguments: args,
      sourceName: diff.type === "added" ? undefined : diff.name,
      targetName: diff.type === "removed" ? undefined : diff.name,
      selected: true,
      sourceDdl: diff.source?.definition,
      targetDdl: diff.target?.definition,
      changes: diff.changes,
    });
  }

  for (const diff of sequenceDiffs) {
    objects.push({
      id: `seq-${diff.name}`,
      operationType: getOperationType(diff.type),
      objectKind: "sequence",
      name: diff.name,
      sourceName: diff.type === "added" ? undefined : diff.name,
      targetName: diff.type === "removed" ? undefined : diff.name,
      selected: true,
      sourceDdl: diff.source ? buildSequenceDdl(diff.source) : undefined,
      targetDdl: diff.target ? buildSequenceDdl(diff.target) : undefined,
      changes: diff.changes,
    });
  }

  for (const diff of ruleDiffs) {
    objects.push({
      id: `rule-${diff.name}`,
      operationType: getOperationType(diff.type),
      objectKind: "rule",
      name: diff.name,
      sourceName: diff.type === "added" ? undefined : diff.name,
      targetName: diff.type === "removed" ? undefined : diff.name,
      selected: true,
      changes: diff.changes,
    });
  }

  for (const diff of ownerDiffs) {
    objects.push({
      id: `owner-${diff.objectName}`,
      operationType: getOperationType(diff.type),
      objectKind: "owner",
      name: diff.objectName,
      sourceName: diff.type === "added" ? undefined : diff.objectName,
      targetName: diff.type === "removed" ? undefined : diff.objectName,
      selected: true,
      changes: diff.changes,
    });
  }

  // Pre-mark rename candidates on diff objects (for UI display before user confirms)
  if (renameCandidates && renameCandidates.length > 0) {
    for (const rc of renameCandidates) {
      for (const obj of objects) {
        // Backend-detected renames: diff_type = "renamed", already has metadata set above
        if (obj.renameMetadata) continue;
        // Legacy: mark rename candidates on delete+create pairs (fallback for older backends)
        if (obj.operationType === "delete" && obj.name === rc.sourceName) {
          obj.renameMetadata = { confirmed: false, targetName: rc.targetName, score: rc.score };
        }
        if (obj.operationType === "create" && obj.name === rc.targetName) {
          obj.renameMetadata = { confirmed: false, sourceName: rc.sourceName, score: rc.score };
          obj.sourceName = rc.sourceName;
        }
      }
    }
  }

  return objects;
}

export function buildDeploySqlForObjects(objects: SchemaDiffObject[]): string {
  const selected = objects.filter((o) => {
    return o.selected && o.operationType !== "none" && !o.parentId;
  });

  if (selected.length === 0) {
    return "-- No objects selected";
  }

  const lines: string[] = [];

  for (const obj of selected) {
    if (obj.deploySql?.trim()) {
      lines.push(obj.deploySql.trim());
      lines.push("");
      continue;
    }

    if (obj.operationType === "create") {
      if (obj.sourceDdl) {
        lines.push(`-- Create ${obj.objectKind}: ${obj.name}`);
        lines.push(obj.sourceDdl);
        lines.push("");
      }
    } else if (obj.operationType === "delete") {
      lines.push(`-- Drop ${obj.objectKind}: ${obj.name}`);
      const dropSql = generateDropSql(obj);
      lines.push(dropSql);
      lines.push("");
    } else if (obj.operationType === "modify") {
      if (obj.sourceDdl) {
        lines.push(`-- Modify ${obj.objectKind}: ${obj.name}`);
        lines.push(obj.sourceDdl);
        lines.push("");
      }
    }
  }

  return lines.join("\n") || "-- No DDL available for selected objects";
}

function generateDropSql(obj: SchemaDiffObject): string {
  const typeMap: Record<string, string> = {
    table: "TABLE",
    view: "VIEW",
    function: "FUNCTION",
    sequence: "SEQUENCE",
    rule: "RULE",
    owner: "OWNED BY",
  };
  const sqlType = typeMap[obj.objectKind] || obj.objectKind.toUpperCase();
  return `DROP ${sqlType} IF EXISTS ${obj.name};`;
}

/** Detect column renames in raw SQL and replace DROP+ADD with RENAME COLUMN. */
export function injectColumnRenameSql(sql: string, diffs: TableDiff[], threshold: number, reverse = false): string {
  if (!sql || !threshold) return sql;

  // Build rename pairs: for each table, match removed columns with added columns by similarity
  const replacements: { table: string; oldName: string; newName: string }[] = [];
  for (const diff of diffs) {
    if (!diff.columns || diff.type !== "modified") continue;
    const removedCols = diff.columns.filter((c) => c.type === "removed");
    const addedCols = diff.columns.filter((c) => c.type === "added");
    if (removedCols.length === 0 || addedCols.length === 0) continue;

    const used = new Set<string>();
    for (const rc of removedCols) {
      let best: (typeof addedCols)[0] | null = null;
      let bestSim = 0;
      for (const ac of addedCols) {
        if (used.has(ac.name)) continue;
        const sim = nameSimilarity(rc.name, ac.name);
        if (sim > bestSim) {
          bestSim = sim;
          best = ac;
        }
      }
      if (best && bestSim >= threshold) {
        // rc = removed column (exists in source, NOT in target → needs to be ADDED to target)
        // best = added column (exists in target, NOT in source → needs to be DROPPED from target)
        // To sync target → source: rename target's "best.name" to source's "rc.name"
        replacements.push({ table: diff.name, oldName: best.name, newName: rc.name });
        used.add(best.name);
      }
    }
  }

  if (replacements.length === 0) return sql;

  // Process each ALTER TABLE block
  const lines = sql.split("\n");
  const out: string[] = [];
  let currentTable = "";
  let inAlter = false;
  let alterStart = -1;
  const tableRenames = new Map<string, typeof replacements>();

  for (const r of replacements) {
    const list = tableRenames.get(r.table) || [];
    list.push(r);
    tableRenames.set(r.table, list);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect ALTER TABLE <table>
    const alterMatch = trimmed.match(/^ALTER\s+TABLE\s+(?:`[^`]+`\.)?`?(\w+)`?/i);
    if (alterMatch && !inAlter) {
      currentTable = alterMatch[1];
      const renames = tableRenames.get(currentTable);
      if (renames) {
        inAlter = true;
        alterStart = i;
        continue; // skip current ALTER TABLE line, we'll rebuild it
      }
    }

    if (!inAlter) {
      out.push(line);
      continue;
    }

    // Inside an ALTER TABLE block being rewritten
    const endOfAlter = trimmed === ";" || trimmed.endsWith(";") || (i + 1 < lines.length && lines[i + 1].trim().toUpperCase().startsWith("ALTER")) || i === lines.length - 1;

    if (endOfAlter) {
      const renames = tableRenames.get(currentTable)!;
      // Emit RENAME COLUMN statements
      out.push(`-- Alter table: ${currentTable} (column renames detected)`);
      for (const r of renames) {
        const fromName = reverse ? r.newName : r.oldName;
        const toName = reverse ? r.oldName : r.newName;
        out.push(`ALTER TABLE ${currentTable} RENAME COLUMN ${fromName} TO ${toName};`);
      }
      // Collect remaining ALTER clauses (non-renamed columns)
      const remaining: string[] = [];
      for (let j = alterStart + 1; j <= i; j++) {
        const l = lines[j].trim();
        if (!l || l === ";") continue;
        // Forward: ADD for newName, DROP for oldName. Reverse: ADD for oldName, DROP for newName.
        const isAddRename = l.toUpperCase().startsWith("ADD COLUMN") && renames.some((r) => l.includes(reverse ? r.oldName : r.newName));
        const isDropRename = l.toUpperCase().startsWith("DROP COLUMN") && renames.some((r) => l.includes(reverse ? r.newName : r.oldName));
        if (isAddRename || isDropRename) continue;
        // Clean trailing comma if next line is removed
        let cleaned = l;
        let nextIdx = j + 1;
        while (nextIdx <= i) {
          const nextLine = lines[nextIdx].trim();
          if (!nextLine) {
            nextIdx++;
            continue;
          }
          const nextIsAddRename = nextLine.toUpperCase().startsWith("ADD COLUMN") && renames.some((r) => nextLine.includes(reverse ? r.oldName : r.newName));
          const nextIsDropRename = nextLine.toUpperCase().startsWith("DROP COLUMN") && renames.some((r) => nextLine.includes(reverse ? r.newName : r.oldName));
          if (nextIsAddRename || nextIsDropRename) {
            cleaned = cleaned.replace(/,\s*$/, "");
          }
          break;
        }
        remaining.push(cleaned);
      }
      if (remaining.length > 0) {
        const last = remaining[remaining.length - 1].replace(/,\s*$/, "").replace(/;\s*$/, "");
        remaining[remaining.length - 1] = last;
        out.push(`ALTER TABLE ${currentTable}`);
        for (const r of remaining) {
          out.push(`  ${r}`);
        }
        out.push(";");
      }
      inAlter = false;
      currentTable = "";
    }
  }

  return out.join("\n").trim();
}

export interface ObjectTypeGroup {
  kind: DiffObjectKind;
  label: string;
  objects: SchemaDiffObject[];
  expanded: boolean;
  selectedCount: number;
}

export interface OperationGroup {
  operationType: DiffOperationType;
  label: string;
  count: number;
  selectedCount: number;
  expanded: boolean;
  typeGroups: ObjectTypeGroup[];
}

export function flattenSchemaDiffObjects(objects: SchemaDiffObject[]): SchemaDiffObject[] {
  return objects.flatMap((object) => [object, ...flattenSchemaDiffObjects(object.children ?? [])]);
}

export function findSchemaDiffObject(objects: SchemaDiffObject[], objectId: string): SchemaDiffObject | undefined {
  return flattenSchemaDiffObjects(objects).find((object) => object.id === objectId);
}

export function setSchemaDiffObjectSelected(objects: SchemaDiffObject[], objectId: string, selected: boolean): boolean {
  const object = findSchemaDiffObject(objects, objectId);
  if (!object) return false;

  // Table sync SQL is generated as one deploy unit. A child toggle therefore
  // selects or clears its whole table so hidden sibling DDL cannot still run.
  const selectionOwner = object.parentId ? findSchemaDiffObject(objects, object.parentId) : object;
  if (!selectionOwner) return false;

  const applySelection = (target: SchemaDiffObject) => {
    target.selected = selected;
    for (const child of target.children ?? []) applySelection(child);
  };
  applySelection(selectionOwner);
  return true;
}

export function selectedSchemaDiffObjects(objects: SchemaDiffObject[]): SchemaDiffObject[] {
  return objects.filter((object) => object.selected && object.operationType !== "none");
}

export function schemaDiffSelectionOwnerId(object: SchemaDiffObject): string {
  return object.parentId ?? object.id;
}

export function summarizeSchemaDiffOperations(objects: SchemaDiffObject[]): Record<DiffOperationType, number> {
  const counts: Record<DiffOperationType, number> = { create: 0, modify: 0, delete: 0, none: 0 };
  for (const object of schemaDiffReviewObjects(objects)) {
    if (object.selected && object.operationType !== "none") counts[object.operationType]++;
  }
  return counts;
}

export type SchemaDiffReviewAlert = "destructive" | "compatibility" | null;

export function schemaDiffReviewAlert(destructiveStatementCount: number, compatibilityWarningCount: number): SchemaDiffReviewAlert {
  if (destructiveStatementCount > 0) return "destructive";
  if (compatibilityWarningCount > 0) return "compatibility";
  return null;
}

export function groupDiffObjects(objects: SchemaDiffObject[]): OperationGroup[] {
  const groups: Record<DiffOperationType, Record<DiffObjectKind, SchemaDiffObject[]>> = {
    modify: {
      table: [],
      view: [],
      function: [],
      sequence: [],
      rule: [],
      owner: [],
      column: [],
      index: [],
      foreignKey: [],
      trigger: [],
    },
    create: {
      table: [],
      view: [],
      function: [],
      sequence: [],
      rule: [],
      owner: [],
      column: [],
      index: [],
      foreignKey: [],
      trigger: [],
    },
    delete: {
      table: [],
      view: [],
      function: [],
      sequence: [],
      rule: [],
      owner: [],
      column: [],
      index: [],
      foreignKey: [],
      trigger: [],
    },
    none: {
      table: [],
      view: [],
      function: [],
      sequence: [],
      rule: [],
      owner: [],
      column: [],
      index: [],
      foreignKey: [],
      trigger: [],
    },
  };

  for (const obj of schemaDiffReviewObjects(objects)) {
    groups[obj.operationType][obj.objectKind].push(obj);
  }

  const order: DiffOperationType[] = ["modify", "create", "delete", "none"];
  return order.map((opType) => {
    const typeGroups: ObjectTypeGroup[] = [];
    const kinds: DiffObjectKind[] = ["table", "view", "function", "sequence", "rule", "owner", "column", "index", "foreignKey", "trigger"];

    for (const kind of kinds) {
      const objs = groups[opType][kind];
      if (objs.length > 0) {
        typeGroups.push({
          kind,
          label: getObjectTypeLabel(kind),
          objects: objs,
          expanded: true,
          selectedCount: objs.filter((o) => o.selected).length,
        });
      }
    }

    const allObjects = Object.values(groups[opType]).flat();
    return {
      operationType: opType,
      label: getOperationLabel(opType),
      count: allObjects.length,
      selectedCount: allObjects.filter((o) => o.selected).length,
      expanded: opType !== "none",
      typeGroups,
    };
  });
}

function schemaDiffReviewObjects(objects: SchemaDiffObject[]): SchemaDiffObject[] {
  return objects.flatMap((object) => {
    if (object.operationType !== "modify") return [object];

    const destructiveChildren = flattenSchemaDiffObjects(object.children ?? []).filter((child) => child.operationType === "delete");
    if (destructiveChildren.length === 0) return [object];

    const deleteReviewObject: SchemaDiffObject = {
      ...object,
      id: `delete-risk-${object.id}`,
      operationType: "delete",
      sourceName: undefined,
      targetName: object.targetName ?? object.name,
      children: undefined,
      parentId: object.id,
      changes: destructiveChildren.flatMap((child) => child.changes ?? []),
    };
    return [object, deleteReviewObject];
  });
}

function getObjectTypeLabel(kind: DiffObjectKind): string {
  switch (kind) {
    case "table":
      return "diff.objectKindLabel.table";
    case "view":
      return "diff.objectKindLabel.view";
    case "function":
      return "diff.objectKindLabel.function";
    case "sequence":
      return "diff.objectKindLabel.sequence";
    case "rule":
      return "diff.objectKindLabel.rule";
    case "owner":
      return "diff.objectKindLabel.owner";
    case "column":
      return "diff.objectKindLabel.column";
    case "index":
      return "diff.objectKindLabel.index";
    case "foreignKey":
      return "diff.objectKindLabel.foreignKey";
    case "trigger":
      return "diff.objectKindLabel.trigger";
    default:
      return kind;
  }
}
