import type { ColumnInfo, IndexInfo, ForeignKeyInfo, TriggerInfo, FunctionInfo, SequenceInfo, RuleInfo, OwnerInfo, DatabaseType, TableInfo } from "@/types/database";

export interface ColumnDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ColumnInfo;
  target?: ColumnInfo;
  changes?: string[];
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
  type: "added" | "removed" | "modified";
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
}

export interface TableSchemaDetail {
  name: string;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  triggers?: TriggerInfo[];
  ddl?: string;
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
}

export interface SchemaDiffPreparation {
  diffs: TableDiff[];
  functionDiffs?: FunctionDiff[];
  sequenceDiffs?: SequenceDiff[];
  ruleDiffs?: RuleDiff[];
  ownerDiffs?: OwnerDiff[];
  syncSql: string;
}

// Unified object type for UI display
export type DiffOperationType = "modify" | "create" | "delete" | "none";
export type DiffObjectKind = "table" | "view" | "function" | "sequence" | "rule" | "owner" | "index" | "trigger" | "foreignKey";

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
  changes?: string[];
  children?: SchemaDiffObject[];
  /** Function arguments signature (for PostgreSQL overloaded functions) */
  arguments?: string;
}

export interface SchemaDiffGroup {
  operationType: DiffOperationType;
  label: string;
  count: number;
  selectedCount: number;
  expanded: boolean;
  objects: SchemaDiffObject[];
}

export function getOperationType(diffType: string): DiffOperationType {
  switch (diffType) {
    case "modified":
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

export function convertToSchemaDiffObjects(tableDiffs: TableDiff[], functionDiffs: FunctionDiff[] = [], sequenceDiffs: SequenceDiff[] = [], ruleDiffs: RuleDiff[] = [], ownerDiffs: OwnerDiff[] = []): SchemaDiffObject[] {
  const objects: SchemaDiffObject[] = [];

  for (const diff of tableDiffs) {
    const opType = getOperationType(diff.type);
    const obj: SchemaDiffObject = {
      id: `table-${diff.name}`,
      operationType: opType,
      objectKind: diff.objectType === "view" ? "view" : "table",
      name: diff.name,
      sourceName: diff.type === "added" ? undefined : diff.name,
      targetName: diff.type === "removed" ? undefined : diff.name,
      selected: opType !== "none",
      sourceDdl: diff.ddl,
      targetDdl: diff.targetDdl,
      changes: diff.columns?.flatMap((c) => c.changes || []),
      children: [
        ...(diff.columns?.map((c) => ({
          id: `col-${diff.name}-${c.name}`,
          operationType: getOperationType(c.type),
          objectKind: "table" as DiffObjectKind,
          name: c.name,
          sourceName: c.type === "added" ? undefined : c.name,
          targetName: c.type === "removed" ? undefined : c.name,
          selected: opType !== "none",
          changes: c.changes,
        })) || []),
        ...(diff.indexes?.map((i) => ({
          id: `idx-${diff.name}-${i.name}`,
          operationType: getOperationType(i.type),
          objectKind: "index" as DiffObjectKind,
          name: i.name,
          sourceName: i.type === "added" ? undefined : i.name,
          targetName: i.type === "removed" ? undefined : i.name,
          selected: opType !== "none",
          changes: i.changes,
        })) || []),
        ...(diff.foreignKeys?.map((f) => ({
          id: `fk-${diff.name}-${f.name}`,
          operationType: getOperationType(f.type),
          objectKind: "foreignKey" as DiffObjectKind,
          name: f.name,
          sourceName: f.type === "added" ? undefined : f.name,
          targetName: f.type === "removed" ? undefined : f.name,
          selected: opType !== "none",
          changes: f.changes,
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

  return objects;
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

export function groupDiffObjects(objects: SchemaDiffObject[]): OperationGroup[] {
  const groups: Record<DiffOperationType, Record<DiffObjectKind, SchemaDiffObject[]>> = {
    modify: {
      table: [],
      view: [],
      function: [],
      sequence: [],
      rule: [],
      owner: [],
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
      index: [],
      foreignKey: [],
      trigger: [],
    },
  };

  for (const obj of objects) {
    groups[obj.operationType][obj.objectKind].push(obj);
  }

  const order: DiffOperationType[] = ["modify", "create", "delete", "none"];
  return order.map((opType) => {
    const typeGroups: ObjectTypeGroup[] = [];
    const kinds: DiffObjectKind[] = ["table", "view", "function", "sequence", "rule", "owner", "index", "foreignKey", "trigger"];

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
