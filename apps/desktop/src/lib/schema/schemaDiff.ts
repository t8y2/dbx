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
  type: "added" | "removed" | "modified" | "renamed";
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
  paramStrategy?: "preserve" | "strip" | "custom";
  customParams?: string;
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

interface RawSchemaDiffDependencyNode {
  tableName?: unknown;
  table_name?: unknown;
  dependsOn?: unknown;
  depends_on?: unknown;
  dependedBy?: unknown;
  depended_by?: unknown;
}

interface RawSchemaDiffDependencyGraph {
  nodes?: RawSchemaDiffDependencyNode[] | Record<string, RawSchemaDiffDependencyNode>;
}

export function normalizeSchemaDiffDependencyGraph(graph: unknown): DependencyGraph | null {
  if (!graph || typeof graph !== "object") return null;

  const rawNodes = (graph as RawSchemaDiffDependencyGraph).nodes;
  const entries = Array.isArray(rawNodes) ? rawNodes : rawNodes && typeof rawNodes === "object" ? Object.values(rawNodes) : [];
  const nodes = entries.flatMap((node) => {
    const tableName = typeof node.tableName === "string" ? node.tableName : typeof node.table_name === "string" ? node.table_name : "";
    if (!tableName) return [];

    const dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn : Array.isArray(node.depends_on) ? node.depends_on : [];
    const dependedBy = Array.isArray(node.dependedBy) ? node.dependedBy : Array.isArray(node.depended_by) ? node.depended_by : [];
    return [
      {
        tableName,
        dependsOn: dependsOn.filter((name): name is string => typeof name === "string"),
        dependedBy: dependedBy.filter((name): name is string => typeof name === "string"),
      },
    ];
  });

  return nodes.length > 0 ? { nodes } : null;
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

export interface SchemaSyncSqlPlan {
  syncSql: string;
  rollbackSyncSql?: string;
  rollbackCompleteness: RollbackCompleteness;
  missingRollbackObjects: MissingRollbackObject[];
}

export interface GenerateSchemaSyncPlanOptions {
  databaseType: DatabaseType;
  targetSchema?: string;
  cascadeDelete?: boolean;
  sourceDialect?: string;
  fieldMappings?: FieldMappingEntry[];
  enableRollback?: boolean;
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
export type DiffObjectKind = "table" | "view" | "function" | "sequence" | "rule" | "owner" | "column" | "index" | "trigger" | "foreignKey" | "tableOption";

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

function tableObjectId(tableName: string): string {
  return `table-${tableName}`;
}

function columnObjectId(tableName: string, columnName: string): string {
  return `col-${tableName}-${columnName}`;
}

function indexObjectId(tableName: string, indexName: string): string {
  return `idx-${tableName}-${indexName}`;
}

function foreignKeyObjectId(tableName: string, foreignKeyName: string): string {
  return `fk-${tableName}-${foreignKeyName}`;
}

function triggerObjectId(tableName: string, triggerName: string): string {
  return `trg-${tableName}-${triggerName}`;
}

function tableOptionObjectId(tableName: string): string {
  return `table-option-${tableName}`;
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
    const tableId = tableObjectId(diff.name);
    const children: SchemaDiffObject[] =
      opType === "modify"
        ? [
            ...(diff.columns?.map((column) => ({
              id: columnObjectId(diff.name, column.name),
              operationType: getOperationType(column.type),
              objectKind: "column" as DiffObjectKind,
              name: column.name,
              sourceName: column.type === "added" ? undefined : column.name,
              targetName: column.type === "removed" ? undefined : column.name,
              selected: true,
              changes: column.changes,
              parentId: tableId,
              parentName: diff.name,
            })) || []),
            ...(diff.indexes?.map((index) => ({
              id: indexObjectId(diff.name, index.name),
              // A modified index is one DROP + CREATE deploy unit.
              operationType: index.type === "modified" ? ("delete" as DiffOperationType) : getOperationType(index.type),
              objectKind: "index" as DiffObjectKind,
              name: index.name,
              sourceName: index.type === "added" ? undefined : index.name,
              targetName: index.type === "removed" ? undefined : index.name,
              selected: true,
              changes: index.changes,
              parentId: tableId,
              parentName: diff.name,
            })) || []),
            ...(diff.foreignKeys?.map((foreignKey) => ({
              id: foreignKeyObjectId(diff.name, foreignKey.name),
              // Modified foreign keys are also dropped before they are recreated.
              operationType: foreignKey.type === "modified" ? ("delete" as DiffOperationType) : getOperationType(foreignKey.type),
              objectKind: "foreignKey" as DiffObjectKind,
              name: foreignKey.name,
              sourceName: foreignKey.type === "added" ? undefined : foreignKey.name,
              targetName: foreignKey.type === "removed" ? undefined : foreignKey.name,
              selected: true,
              changes: foreignKey.changes,
              parentId: tableId,
              parentName: diff.name,
            })) || []),
            ...(diff.triggers?.map((trigger) => ({
              id: triggerObjectId(diff.name, trigger.name),
              operationType: getOperationType(trigger.type),
              objectKind: "trigger" as DiffObjectKind,
              name: trigger.name,
              sourceName: trigger.type === "added" ? undefined : trigger.name,
              targetName: trigger.type === "removed" ? undefined : trigger.name,
              selected: true,
              changes: trigger.changes,
              parentId: tableId,
              parentName: diff.name,
            })) || []),
            ...(diff.sourceTableComment !== diff.targetTableComment
              ? [
                  {
                    id: tableOptionObjectId(diff.name),
                    operationType: "modify" as DiffOperationType,
                    objectKind: "tableOption" as DiffObjectKind,
                    name: "tableOption",
                    selected: true,
                    changes: [`comment: ${diff.targetTableComment ?? ""} -> ${diff.sourceTableComment ?? ""}`],
                    parentId: tableId,
                    parentName: diff.name,
                  },
                ]
              : []),
          ]
        : [];

    const obj: SchemaDiffObject = {
      id: tableId,
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
      children: children.length > 0 ? children : undefined,
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

export interface SelectedSchemaDiffInput {
  diffs: TableDiff[];
  functionDiffs: FunctionDiff[];
  sequenceDiffs: SequenceDiff[];
  ruleDiffs: RuleDiff[];
  ownerDiffs: OwnerDiff[];
}

/** Project the original structured diff onto the current result-tree selection. */
export function selectSchemaDiffInput(result: SchemaDiffPreparation, objects: SchemaDiffObject[]): SelectedSchemaDiffInput {
  const selectedIds = new Set(
    flattenSchemaDiffObjects(objects)
      .filter((object) => object.selected && object.operationType !== "none")
      .map((object) => object.id),
  );

  const diffs = result.diffs.flatMap((diff): TableDiff[] => {
    const tableObject = findSchemaDiffObject(objects, tableObjectId(diff.name));
    if (!tableObject) return [];

    const isAtomic = diff.type !== "modified" || diff.objectType === "view" || !tableObject.children?.length;
    if (isAtomic) {
      return tableObject.selected ? [{ ...diff, syncSql: undefined }] : [];
    }

    const columns = diff.columns?.filter((column) => selectedIds.has(columnObjectId(diff.name, column.name))) ?? [];
    const indexes = diff.indexes?.filter((index) => selectedIds.has(indexObjectId(diff.name, index.name))) ?? [];
    const foreignKeys = diff.foreignKeys?.filter((foreignKey) => selectedIds.has(foreignKeyObjectId(diff.name, foreignKey.name))) ?? [];
    const triggers = diff.triggers?.filter((trigger) => selectedIds.has(triggerObjectId(diff.name, trigger.name))) ?? [];
    const includeTableOptions = selectedIds.has(tableOptionObjectId(diff.name));

    if (columns.length === 0 && indexes.length === 0 && foreignKeys.length === 0 && triggers.length === 0 && !includeTableOptions) {
      return [];
    }

    return [
      {
        ...diff,
        columns,
        indexes,
        foreignKeys,
        triggers,
        sourceTableComment: includeTableOptions ? diff.sourceTableComment : undefined,
        targetTableComment: includeTableOptions ? diff.targetTableComment : undefined,
        syncSql: undefined,
      },
    ];
  });

  return {
    diffs,
    functionDiffs: (result.functionDiffs ?? []).filter((diff) => selectedIds.has(`func-${diff.name}-${diff.source?.arguments || diff.target?.arguments || ""}`)),
    sequenceDiffs: (result.sequenceDiffs ?? []).filter((diff) => selectedIds.has(`seq-${diff.name}`)),
    ruleDiffs: (result.ruleDiffs ?? []).filter((diff) => selectedIds.has(`rule-${diff.name}`)),
    ownerDiffs: (result.ownerDiffs ?? []).filter((diff) => selectedIds.has(`owner-${diff.objectName}`)),
  };
}

function projectSchemaDiffObjectSelection(object: SchemaDiffObject, focusedObjectId: string, selectDescendants: boolean, dependencyNames: ReadonlySet<string>): SchemaDiffObject {
  const isFocused = object.id === focusedObjectId;
  const isDependency = !object.parentId && dependencyNames.has(object.name);
  const selectChildren = selectDescendants || isFocused || isDependency;
  return {
    ...object,
    selected: isFocused || selectDescendants || isDependency,
    children: object.children?.map((child) => projectSchemaDiffObjectSelection(child, focusedObjectId, selectChildren, dependencyNames)),
  };
}

function schemaDiffDependencyClosure(result: SchemaDiffPreparation, objects: SchemaDiffObject[], objectId: string): Set<string> {
  const focusedObject = findSchemaDiffObject(objects, objectId);
  if (!focusedObject) return new Set();

  const rootObject = focusedObject.parentId ? findSchemaDiffObject(objects, focusedObject.parentId) : focusedObject;
  if (!rootObject) return new Set();

  const dependencyNodes = new Map((normalizeSchemaDiffDependencyGraph(result.dependencyGraph)?.nodes ?? []).map((node) => [node.tableName, node]));
  const dependencies = new Set<string>();
  const pending = [rootObject.name];
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name) continue;
    for (const dependency of dependencyNodes.get(name)?.dependsOn ?? []) {
      if (dependency === rootObject.name || dependencies.has(dependency)) continue;
      dependencies.add(dependency);
      pending.push(dependency);
    }
  }
  return dependencies;
}

/** Project one focused tree object onto a fresh selection without mutating checkbox state. */
export function selectSchemaDiffInputForObject(result: SchemaDiffPreparation, objects: SchemaDiffObject[], objectId: string): SelectedSchemaDiffInput {
  if (!findSchemaDiffObject(objects, objectId)) {
    return { diffs: [], functionDiffs: [], sequenceDiffs: [], ruleDiffs: [], ownerDiffs: [] };
  }

  const dependencyNames = schemaDiffDependencyClosure(result, objects, objectId);
  const focusedSelection = objects.map((object) => projectSchemaDiffObjectSelection(object, objectId, false, dependencyNames));
  return selectSchemaDiffInput(result, focusedSelection);
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

  const applySelection = (target: SchemaDiffObject) => {
    target.selected = selected;
    for (const child of target.children ?? []) applySelection(child);
  };
  applySelection(object);

  if (object.parentId) {
    const parent = findSchemaDiffObject(objects, object.parentId);
    if (parent) {
      const children = parent.children?.filter((child) => child.operationType !== "none") ?? [];
      parent.selected = children.length > 0 && children.every((child) => child.selected);
    }
  }
  return true;
}

/** Apply one leaf selection while keeping generated DDL dependencies executable. */
export function setSchemaDiffObjectSelectedWithDependencies(objects: SchemaDiffObject[], result: SchemaDiffPreparation, objectId: string, selected: boolean): boolean {
  const changed = setSchemaDiffObjectSelected(objects, objectId, selected);
  const initialObject = findSchemaDiffObject(objects, objectId);
  if (!changed || !initialObject?.parentId) return changed;

  const visited = new Set<string>();
  const apply = (id: string, value: boolean) => {
    if (visited.has(`${id}:${value}`)) return;
    visited.add(`${id}:${value}`);

    const object = findSchemaDiffObject(objects, id);
    if (!object?.parentId) return;
    const tableObject = findSchemaDiffObject(objects, object.parentId);
    const tableDiff = result.diffs.find((diff) => diff.name === tableObject?.name);
    if (!tableObject || !tableDiff) return;
    setSchemaDiffObjectSelected(objects, id, value);

    const child = (kind: DiffObjectKind, name: string) => tableObject.children?.find((candidate) => candidate.objectKind === kind && candidate.name === name);
    const applyColumn = (name: string, value: boolean) => {
      const columnDiff = tableDiff.columns?.find((column) => column.name === name);
      const columnObject = child("column", name);
      if (!columnDiff || !columnObject) return;
      if (value && !["added", "renamed"].includes(columnDiff.type)) return;
      apply(columnObject.id, value);
    };

    if (object.objectKind === "column") {
      const columnDiff = tableDiff.columns?.find((column) => column.name === object.name);
      if (!columnDiff) return;

      if (value && columnDiff.type === "added" && columnDiff.addPosition && typeof columnDiff.addPosition === "object") {
        applyColumn(columnDiff.addPosition.after, true);
      }

      if (value && columnDiff.type === "removed") {
        for (const index of tableDiff.indexes ?? []) {
          if (!["removed", "modified"].includes(index.type) || !index.target?.columns.includes(columnDiff.name)) continue;
          const indexObject = child("index", index.name);
          if (indexObject) apply(indexObject.id, true);
        }
        for (const foreignKey of tableDiff.foreignKeys ?? []) {
          if (!["removed", "modified"].includes(foreignKey.type) || foreignKey.target?.column !== columnDiff.name) continue;
          const foreignKeyObject = child("foreignKey", foreignKey.name);
          if (foreignKeyObject) apply(foreignKeyObject.id, true);
        }
      }

      if (!value && ["added", "renamed"].includes(columnDiff.type)) {
        for (const dependentColumn of tableDiff.columns ?? []) {
          if (dependentColumn.type !== "added" || !dependentColumn.addPosition || typeof dependentColumn.addPosition !== "object" || dependentColumn.addPosition.after !== columnDiff.name) continue;
          const dependentObject = child("column", dependentColumn.name);
          if (dependentObject) apply(dependentObject.id, false);
        }
        for (const index of tableDiff.indexes ?? []) {
          const sourceColumns = [...(index.source?.columns ?? []), ...(index.source?.included_columns ?? [])];
          if (!["added", "modified"].includes(index.type) || !sourceColumns.includes(columnDiff.name)) continue;
          const indexObject = child("index", index.name);
          if (indexObject) apply(indexObject.id, false);
        }
        for (const foreignKey of tableDiff.foreignKeys ?? []) {
          if (!["added", "modified"].includes(foreignKey.type) || foreignKey.source?.column !== columnDiff.name) continue;
          const foreignKeyObject = child("foreignKey", foreignKey.name);
          if (foreignKeyObject) apply(foreignKeyObject.id, false);
        }
      }
    }

    if (value && object.objectKind === "index") {
      const index = tableDiff.indexes?.find((candidate) => candidate.name === object.name);
      for (const columnName of [...(index?.source?.columns ?? []), ...(index?.source?.included_columns ?? [])]) {
        applyColumn(columnName, true);
      }
    }

    if (value && object.objectKind === "foreignKey") {
      const foreignKey = tableDiff.foreignKeys?.find((candidate) => candidate.name === object.name);
      if (foreignKey?.source?.column) applyColumn(foreignKey.source.column, true);
    }
  };

  visited.clear();
  apply(objectId, selected);
  return true;
}

export function selectedSchemaDiffObjects(objects: SchemaDiffObject[]): SchemaDiffObject[] {
  return objects.flatMap((object) => {
    const children = object.children?.filter((child) => child.operationType !== "none") ?? [];
    if (children.length > 0) return children.filter((child) => child.selected);
    return object.selected && object.operationType !== "none" ? [object] : [];
  });
}

export function schemaDiffSelectionTargets(object: SchemaDiffObject): SchemaDiffObject[] {
  const children = object.children?.filter((child) => child.operationType !== "none") ?? [];
  return children.length > 0 ? children : [object];
}

export function schemaDiffObjectSelectionState(object: SchemaDiffObject): { checked: boolean; indeterminate: boolean } {
  const targets = schemaDiffSelectionTargets(object);
  const selectedCount = targets.filter((target) => target.selected).length;
  return {
    checked: targets.length > 0 && selectedCount === targets.length,
    indeterminate: selectedCount > 0 && selectedCount < targets.length,
  };
}

export function summarizeSchemaDiffOperations(objects: SchemaDiffObject[]): Record<DiffOperationType, number> {
  const counts: Record<DiffOperationType, number> = { create: 0, modify: 0, delete: 0, none: 0 };
  for (const object of selectedSchemaDiffObjects(objects)) {
    counts[object.operationType]++;
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
      tableOption: [],
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
      tableOption: [],
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
      tableOption: [],
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
      tableOption: [],
    },
  };

  // Classification is presence-based (DBeaver structure-compare semantics): an
  // object that exists on both sides keeps operationType "modify" and carries
  // its per-child operations in the drill-down, so only target-only objects
  // ("delete") and source-only objects ("create") appear in those groups. A
  // both-side table must never be re-bucketed as delete/create just because
  // some of its columns or indexes differ.
  for (const obj of objects) {
    groups[obj.operationType][obj.objectKind].push(obj);
  }

  const order: DiffOperationType[] = ["modify", "create", "delete", "none"];
  return order.map((opType) => {
    const typeGroups: ObjectTypeGroup[] = [];
    const kinds: DiffObjectKind[] = ["table", "view", "function", "sequence", "rule", "owner", "column", "index", "foreignKey", "trigger", "tableOption"];

    for (const kind of kinds) {
      const objs = groups[opType][kind];
      if (objs.length > 0) {
        typeGroups.push({
          kind,
          label: getObjectTypeLabel(kind),
          objects: objs,
          expanded: true,
          selectedCount: objs.flatMap(schemaDiffSelectionTargets).filter((object) => object.selected).length,
        });
      }
    }

    const allObjects = Object.values(groups[opType]).flat();
    const selectionTargets = allObjects.flatMap(schemaDiffSelectionTargets);
    return {
      operationType: opType,
      label: getOperationLabel(opType),
      count: selectionTargets.length,
      selectedCount: selectionTargets.filter((object) => object.selected).length,
      expanded: opType !== "none",
      typeGroups,
    };
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
    case "tableOption":
      return "diff.objectKindLabel.tableOption";
    default:
      return kind;
  }
}
