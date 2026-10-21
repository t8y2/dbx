import * as api from "@/lib/backend/api";
import { readOracleIndexSnapshot, type OracleConstraintTarget, type OracleIndexSnapshot } from "@/lib/database/oracleConstraints";
import type { EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";
import { createIndexDrafts } from "@/lib/table/tableStructureEditorState";
import type { ColumnInfo, IndexInfo } from "@/types/database";

export type OracleIndexDefinition = OracleIndexSnapshot["indexes"][number];
type OracleIndexMutation = {
  operation: "CREATE" | "DROP";
  name: string;
  expectedBefore: OracleIndexDefinition[];
  expectedAfter: OracleIndexDefinition[];
  expectedOwnerNamesBefore: string[];
  expectedOwnerNamesAfter: string[];
};

export interface OracleIndexPlan {
  target: OracleConstraintTarget;
  snapshot: OracleIndexSnapshot;
  statements: string[];
  snapshotFingerprint: string;
  mutations: OracleIndexMutation[];
}

export interface OracleIndexLoadBaseline {
  snapshot: OracleIndexSnapshot;
  epoch: number;
  targetIdentity: string;
  requestId: number;
  connectionRevision: number;
  configFingerprint: string;
  columnsFingerprint: string;
  indexesFingerprint: string;
}

export interface OracleIndexPrepareContext {
  baseline: OracleIndexLoadBaseline;
  columnsFingerprint: string;
  indexesFingerprint: string;
}

export interface OracleIndexExecutionResult {
  steps: Array<{ sql: string; state: "committed" | "rejected" | "unknown" | "notExecuted"; error?: string }>;
  readbackError?: string;
}

function invalid(): never {
  throw new Error("Index metadata changed, is incomplete, or is unsupported. Refresh the table definition and preview again.");
}

function parseIdentifierParts(text: string): string[] {
  return [...text.matchAll(/"((?:""|[^"])*)"|([A-Za-z0-9_$#]+)/g)].map((part) => (part[1] === undefined ? part[2]!.toUpperCase() : part[1].replace(/""/g, '"')));
}

function sameTargetIdentity(left: OracleIndexSnapshot, right: OracleIndexSnapshot): boolean {
  return (
    left.user === right.user &&
    left.currentSchema === right.currentSchema &&
    left.database === right.database &&
    left.databaseName === right.databaseName &&
    left.objectId === right.objectId &&
    left.columnReadMode === right.columnReadMode &&
    JSON.stringify(left.userColumns) === JSON.stringify(right.userColumns)
  );
}

function actualIndexMatchesLoaded(index: OracleIndexDefinition, original: IndexInfo, target: OracleConstraintTarget): boolean {
  return (
    index.owner === target.schema &&
    index.tableOwner === target.schema &&
    index.tableName === target.tableName &&
    index.name === original.name &&
    index.indexType === original.index_type &&
    index.uniqueness === (original.is_unique ? "UNIQUE" : "NONUNIQUE") &&
    JSON.stringify(index.columns) === JSON.stringify(original.columns) &&
    JSON.stringify(index.directions) === JSON.stringify(original.key_directions) &&
    JSON.stringify(index.keyIsExpression) === JSON.stringify(original.key_is_expression) &&
    index.visibility === original.visibility
  );
}

function assertOriginalsMatchLoaded(snapshot: OracleIndexSnapshot, target: OracleConstraintTarget, drafts: EditableStructureIndex[]) {
  const originals = drafts.flatMap((draft) => (draft.original && !draft.oracleOriginalMissing ? [draft.original] : []));
  if (originals.length !== snapshot.indexes.length) invalid();
  for (const original of originals) {
    const current = snapshot.indexes.find((index) => index.owner === target.schema && index.name === original.name);
    if (!current || !actualIndexMatchesLoaded(current, original, target)) invalid();
  }
  for (const draft of drafts) {
    if (draft.original && draft.oracleOriginalMissing && snapshot.indexNames.includes(draft.original.name)) invalid();
  }
}

export function oracleIndexSnapshotMatchesLoaded(snapshot: OracleIndexSnapshot, target: OracleConstraintTarget, drafts: EditableStructureIndex[]): boolean {
  try {
    assertOriginalsMatchLoaded(snapshot, target, drafts);
    return true;
  } catch {
    return false;
  }
}

function loadedColumnType(column: OracleIndexSnapshot["columns"][number]): string | undefined {
  const base = column.dataType.toUpperCase();
  if (["VARCHAR2", "CHAR"].includes(base)) {
    if (column.charUsed === "B" && column.length !== null) return `${base}(${column.length} BYTE)`;
    if (column.charUsed === "C" && column.charLength !== null) return `${base}(${column.charLength} CHAR)`;
    const length = column.charLength ?? column.length;
    return length === null ? base : `${base}(${length})`;
  }
  if (["NVARCHAR2", "NCHAR"].includes(base)) {
    const length = column.charLength ?? column.length;
    return length === null ? base : `${base}(${length})`;
  }
  if (base === "NUMBER") {
    if (column.precision === null && column.scale !== null) return `${base}(*,${column.scale})`;
    if (column.precision !== null && Number(column.precision) > 0) return column.scale !== null && Number(column.scale) !== 0 ? `${base}(${column.precision},${column.scale})` : `${base}(${column.precision})`;
    return base;
  }
  if (base === "FLOAT" && column.precision !== null && Number(column.precision) > 0) return `${base}(${column.precision})`;
  if (base === "RAW" && column.length !== null) return `${base}(${column.length})`;
  return base;
}

export function oracleIndexSnapshotMatchesLoadedColumns(snapshot: OracleIndexSnapshot, loadedColumns: Pick<ColumnInfo, "name" | "data_type" | "is_nullable" | "numeric_precision" | "numeric_scale" | "character_maximum_length">[]): boolean {
  const actual = [...loadedColumns].sort((left, right) => left.name.localeCompare(right.name));
  const expected = [...snapshot.userColumns].sort((left, right) => left.name.localeCompare(right.name));
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const wanted = expected[index]!;
      const wantedType = loadedColumnType(wanted);
      const actualType = column.data_type.trim().toUpperCase();
      const expectedBaseType = wanted.dataType.toUpperCase();
      const sameType = snapshot.columnReadMode === "strict-base" ? (expectedBaseType.includes("(") ? actualType.startsWith(expectedBaseType) : actualType.replace(/\s*\([^)]*\)/, "") === expectedBaseType) : !!wantedType && actualType === wantedType;
      const sameKnownNumber = (actualValue: number | null | undefined, expectedValue: string | null) => (expectedValue === null ? actualValue == null : actualValue != null && String(actualValue) === expectedValue);
      const parameter = /^([A-Z0-9_$#]+)\((\d+)(?:\s+(BYTE|CHAR))?\)$/i.exec(actualType);
      const sameKnownLength =
        snapshot.columnReadMode === "enhanced"
          ? wanted.charLength === null
            ? column.character_maximum_length == null
            : column.character_maximum_length != null && String(column.character_maximum_length) === wanted.charLength
          : expectedBaseType === "RAW" || parameter?.[3] === "BYTE"
            ? !!parameter && parameter[1]!.toUpperCase() === expectedBaseType && parameter[2] === wanted.length
            : expectedBaseType === "VARCHAR2" || expectedBaseType === "CHAR" || expectedBaseType === "NVARCHAR2" || expectedBaseType === "NCHAR"
              ? parameter?.[3] === "CHAR"
                ? column.character_maximum_length != null && String(column.character_maximum_length) === parameter[2]
                : !parameter || column.character_maximum_length == null || String(column.character_maximum_length) === parameter[2]
              : true;
      return sameType && sameKnownNumber(column.numeric_precision, wanted.precision) && sameKnownNumber(column.numeric_scale, wanted.scale) && sameKnownLength && column.name === wanted.name && column.is_nullable === wanted.nullable;
    })
  );
}

function validateMutationStatement(sql: string, mutation: { operation: "CREATE" | "DROP"; name: string }, target: OracleConstraintTarget): boolean {
  const atom = '(?:"(?:""|[^"])*"|[A-Za-z0-9_$#]+)';
  const qualified = `(${atom}(?:\\s*\\.\\s*${atom})?)`;
  const match = new RegExp(`^\\s*(CREATE\\s+(?:UNIQUE\\s+)?(?:BITMAP\\s+)?INDEX|DROP\\s+INDEX)\\s+${qualified}`, "i").exec(sql);
  if (!match || (/^CREATE/i.test(match[1]!) ? "CREATE" : "DROP") !== mutation.operation) return false;
  const parts = parseIdentifierParts(match[2]!);
  if (parts.length === 2 && parts[0] !== target.schema) return false;
  if (parts[parts.length - 1] !== mutation.name) return false;
  if (mutation.operation === "CREATE") {
    const tableMatch = new RegExp(`\\bON\\s+${qualified}\\s*\\(`, "i").exec(sql);
    if (!tableMatch) return false;
    const table = parseIdentifierParts(tableMatch[1]!);
    if (table.length === 2 ? table[0] !== target.schema || table[1] !== target.tableName : table[0] !== target.tableName) return false;
  }
  return true;
}

function draftChanged(draft: EditableStructureIndex): boolean {
  const original = draft.original;
  if (!original || draft.oracleOriginalMissing) return true;
  return (
    draft.name !== original.name ||
    JSON.stringify(draft.columns) !== JSON.stringify(original.columns) ||
    draft.isUnique !== original.is_unique ||
    draft.indexType.trim().toUpperCase() !== (original.index_type ?? "").trim().toUpperCase() ||
    JSON.stringify(draft.includedColumns) !== JSON.stringify(original.included_columns ?? []) ||
    draft.filter !== (original.filter ?? "") ||
    draft.comment !== (original.comment ?? "") ||
    JSON.stringify(draft.columnOpclasses ?? []) !== JSON.stringify(original.column_opclasses ?? [])
  );
}

function expectedMutations(drafts: EditableStructureIndex[]): Array<{ operation: "CREATE" | "DROP"; name: string; draft: EditableStructureIndex }> {
  const mutations: Array<{ operation: "CREATE" | "DROP"; name: string; draft: EditableStructureIndex }> = [];
  for (const draft of drafts) {
    if (draft.markedForDrop) {
      if (draft.original && !draft.oracleOriginalMissing) mutations.push({ operation: "DROP", name: draft.original.name, draft });
      continue;
    }
    if (!draft.original) {
      mutations.push({ operation: "CREATE", name: draft.name, draft });
      continue;
    }
    if (draftChanged(draft)) {
      if (!draft.oracleOriginalMissing) mutations.push({ operation: "DROP", name: draft.original.name, draft });
      mutations.push({ operation: "CREATE", name: draft.name, draft });
    }
  }
  return mutations;
}

function expectedCreatedIndex(draft: EditableStructureIndex, target: OracleConstraintTarget): OracleIndexDefinition {
  const original = draft.original;
  const originalPositions = new Map((original?.columns ?? []).map((column, position) => [column, position]));
  const keyIsExpression = draft.columns.map((column) => {
    const position = originalPositions.get(column);
    if (position === undefined) return false;
    const flag = original?.key_is_expression?.[position];
    if (flag === undefined) invalid();
    return flag;
  });
  const directions = draft.columns.map((column) => {
    const position = originalPositions.get(column);
    if (position === undefined) return "ASC";
    const direction = original?.key_directions?.[position];
    if (!direction) invalid();
    return direction;
  });
  const indexType = (draft.indexType || original?.index_type || (keyIsExpression.some(Boolean) ? "FUNCTION-BASED NORMAL" : "NORMAL")).toUpperCase();
  if (!draft.columns.length || !["NORMAL", "FUNCTION-BASED NORMAL"].includes(indexType) || (indexType === "NORMAL" && keyIsExpression.some(Boolean)) || (indexType === "FUNCTION-BASED NORMAL" && !keyIsExpression.some(Boolean))) invalid();
  if (directions.some((direction) => !["ASC", "DESC"].includes(direction))) invalid();
  if (target.databaseType === "oceanbase-oracle" && directions.some((direction) => direction === "DESC")) invalid();
  return {
    owner: target.schema,
    name: draft.name,
    tableOwner: target.schema,
    tableName: target.tableName,
    indexType,
    uniqueness: draft.isUnique ? "UNIQUE" : "NONUNIQUE",
    status: "VALID",
    partitioned: false,
    visibility: original?.visibility || "VISIBLE",
    secondary: original?.constraint_backed ? "Y" : null,
    columns: [...draft.columns],
    directions,
    keyIsExpression,
    includedColumns: [],
    constraints: [],
  };
}

function completedCreateMatchesLoaded(index: IndexInfo, expected: OracleIndexDefinition): boolean {
  return (
    index.name === expected.name &&
    index.is_unique === (expected.uniqueness === "UNIQUE") &&
    !index.is_primary &&
    index.index_type === expected.indexType &&
    index.key_metadata_complete === true &&
    JSON.stringify(index.columns) === JSON.stringify(expected.columns) &&
    JSON.stringify(index.key_is_expression) === JSON.stringify(expected.keyIsExpression) &&
    JSON.stringify(index.key_directions) === JSON.stringify(expected.directions) &&
    index.visibility === expected.visibility &&
    (index.constraint_backed ?? false) === (expected.secondary === "Y")
  );
}

export function mergeOracleIndexDraftsAfterRefresh(drafts: EditableStructureIndex[], actualIndexes: IndexInfo[], completedCreates: OracleIndexDefinition[]): EditableStructureIndex[] {
  const loadedByName = new Map(actualIndexes.map((index) => [index.name, index]));
  const refreshedDrafts: EditableStructureIndex[] = [];
  for (const draft of drafts) {
    const current = loadedByName.get(draft.original?.name || draft.name);
    if (current) {
      loadedByName.delete(current.name);
      refreshedDrafts.push({ ...draft, original: current, indexType: current.index_type ?? draft.indexType, oracleOriginalMissing: false, isPrimary: current.is_primary });
      continue;
    }
    if (draft.original) {
      const expected = completedCreates.find((index) => index.name === draft.name);
      const actual = loadedByName.get(draft.name);
      if (expected && actual && completedCreateMatchesLoaded(actual, expected)) {
        loadedByName.delete(actual.name);
        const committedDraft = { ...draft, original: actual, indexType: actual.index_type ?? draft.indexType, oracleOriginalMissing: false, isPrimary: actual.is_primary };
        refreshedDrafts.push(draftMatchesCompletedCreate(committedDraft, expected) ? createIndexDrafts([actual])[0]! : committedDraft);
        continue;
      }
    }
    if (!draft.markedForDrop) refreshedDrafts.push({ ...draft, oracleOriginalMissing: !!draft.original, isPrimary: false });
  }
  return [...refreshedDrafts, ...createIndexDrafts([...loadedByName.values()])];
}

function draftMatchesCompletedCreate(draft: EditableStructureIndex, expected: OracleIndexDefinition): boolean {
  return !draft.markedForDrop && draft.name === expected.name && draft.isUnique === (expected.uniqueness === "UNIQUE") && draft.indexType.trim().toUpperCase() === expected.indexType && JSON.stringify(draft.columns) === JSON.stringify(expected.columns);
}

function sameExpectedIndexes(actual: OracleIndexDefinition[], expected: OracleIndexDefinition[]): boolean {
  if (actual.length !== expected.length) return false;
  const orderedActual = [...actual].sort((a, b) => a.name.localeCompare(b.name));
  const orderedExpected = [...expected].sort((a, b) => a.name.localeCompare(b.name));
  return orderedActual.every((item, i) => {
    const wanted = orderedExpected[i]!;
    return (
      item.owner === wanted.owner &&
      item.name === wanted.name &&
      item.tableOwner === wanted.tableOwner &&
      item.tableName === wanted.tableName &&
      item.indexType === wanted.indexType &&
      item.uniqueness === wanted.uniqueness &&
      item.status === wanted.status &&
      item.partitioned === wanted.partitioned &&
      item.visibility === wanted.visibility &&
      (wanted.secondary === null ? item.secondary === null || item.secondary === "N" : item.secondary === wanted.secondary) &&
      JSON.stringify(item.columns) === JSON.stringify(wanted.columns) &&
      JSON.stringify(item.directions) === JSON.stringify(wanted.directions) &&
      JSON.stringify(item.keyIsExpression) === JSON.stringify(wanted.keyIsExpression) &&
      JSON.stringify(item.includedColumns) === JSON.stringify(wanted.includedColumns) &&
      JSON.stringify(item.constraints) === JSON.stringify(wanted.constraints)
    );
  });
}

export async function prepareOracleIndexPlan(target: OracleConstraintTarget, statements: string[], drafts: EditableStructureIndex[], context?: OracleIndexPrepareContext): Promise<OracleIndexPlan> {
  const mutationsRequested = expectedMutations(drafts);
  const snapshot = await readOracleIndexSnapshot(
    target,
    () => true,
    mutationsRequested.map((item) => item.name),
  );
  if (context) {
    const { baseline } = context;
    if (!baseline.targetIdentity || !baseline.configFingerprint || baseline.columnsFingerprint !== context.columnsFingerprint || baseline.indexesFingerprint !== context.indexesFingerprint || !sameTargetIdentity(baseline.snapshot, snapshot)) invalid();
  }
  assertOriginalsMatchLoaded(snapshot, target, drafts);
  const planned = [...snapshot.indexes];
  const plannedOwnerNames = new Set(snapshot.indexNames);
  const mutations: OracleIndexMutation[] = [];
  const targets = expectedMutations(drafts);
  if (targets.length !== statements.length || statements.some((sql, index) => !targets[index] || !validateMutationStatement(sql, targets[index]!, target))) invalid();
  for (const mutation of targets) {
    const expectedBefore = [...planned];
    const expectedOwnerNamesBefore = [...plannedOwnerNames].sort();
    if (mutation.operation === "DROP") {
      const current = planned.find((index) => index.name === mutation.name);
      const draft = mutation.draft;
      if (!current || !draft?.original || draft.isPrimary || draft.original.is_primary || draft.original.constraint_backed || current.constraints.length || current.partitioned || !["NORMAL", "FUNCTION-BASED NORMAL"].includes(current.indexType) || current.status !== "VALID") invalid();
      if (!draft.original.key_metadata_complete || !actualIndexMatchesLoaded(current, draft.original, target)) invalid();
      planned.splice(planned.indexOf(current), 1);
      plannedOwnerNames.delete(mutation.name);
    } else {
      if (plannedOwnerNames.has(mutation.name)) invalid();
      const draft = mutation.draft;
      if (!draft || draft.isPrimary || draft.original?.is_primary || draft.original?.constraint_backed) invalid();
      planned.push(expectedCreatedIndex(draft, target));
      plannedOwnerNames.add(mutation.name);
    }
    mutations.push({
      operation: mutation.operation,
      name: mutation.name,
      expectedBefore,
      expectedAfter: [...planned],
      expectedOwnerNamesBefore,
      expectedOwnerNamesAfter: [...plannedOwnerNames].sort(),
    });
  }
  return { target: { ...target }, snapshot, statements: [...statements], snapshotFingerprint: JSON.stringify(snapshot), mutations };
}

export async function executeOracleIndexPlan(plan: OracleIndexPlan, timeoutSecs: number, stillCurrent: () => boolean): Promise<OracleIndexExecutionResult | undefined> {
  const requestedNames = [...new Set(plan.mutations.map((mutation) => mutation.name))];
  const fresh = await readOracleIndexSnapshot(plan.target, stillCurrent, requestedNames);
  if (!stillCurrent()) return undefined;
  if (JSON.stringify(fresh) !== plan.snapshotFingerprint) invalid();
  const originalIdentity = fresh;
  const steps: OracleIndexExecutionResult["steps"] = plan.statements.map((sql) => ({ sql, state: "notExecuted" }));
  for (const [index, step] of steps.entries()) {
    if (!stillCurrent()) break;
    const mutation = plan.mutations[index]!;
    try {
      const before = await readOracleIndexSnapshot(plan.target, stillCurrent, requestedNames);
      if (!stillCurrent()) return { steps, readbackError: "Connection or target changed before index DDL; no further statements were run." };
      if (!sameTargetIdentity(before, originalIdentity) || JSON.stringify(before.indexNames) !== JSON.stringify(mutation.expectedOwnerNamesBefore) || !sameExpectedIndexes(before.indexes, mutation.expectedBefore)) {
        return { steps, readbackError: "Index metadata or constraint support changed before DDL; later statements stopped." };
      }
    } catch (error) {
      return { steps, readbackError: error instanceof Error ? error.message : String(error) };
    }
    try {
      const result = await api.executeQuery(plan.target.connectionId, plan.target.database, step.sql.replace(/;\s*$/, ""), plan.target.schema, undefined, { catalog: plan.target.catalog, timeoutSecs });
      if (!stillCurrent()) {
        step.state = "unknown";
        step.error = "Connection or target changed during execution; outcome is unknown.";
        return { steps, readbackError: "Connection or target changed during index DDL; readback is unknown." };
      }
      if (result.execution_error) {
        step.state = "rejected";
        step.error = result.error?.detail || "Index statement rejected";
      } else {
        step.state = "committed";
      }
    } catch (error) {
      step.state = "unknown";
      step.error = error instanceof Error ? error.message : String(error);
    }
    if (!stillCurrent()) {
      step.state = "unknown";
      step.error = `${step.error ? `${step.error}; ` : ""}Connection or target changed before readback; execution outcome is unknown.`;
      return { steps, readbackError: "Connection or target changed during index DDL; readback is unknown." };
    }
    try {
      const after = await readOracleIndexSnapshot(plan.target, stillCurrent, requestedNames);
      if (!stillCurrent()) {
        step.state = "unknown";
        return { steps, readbackError: "Connection or target changed during index readback; actual state is unknown." };
      }
      if (!sameTargetIdentity(after, originalIdentity)) {
        step.state = "unknown";
        return { steps, readbackError: "Database identity, target table, or column definitions changed during index DDL." };
      }
      if (step.state !== "committed") {
        if (JSON.stringify(after.indexNames) !== JSON.stringify(mutation.expectedOwnerNamesBefore) || !sameExpectedIndexes(after.indexes, mutation.expectedBefore)) {
          step.state = "unknown";
          step.error = `${step.error ? `${step.error}; ` : ""}Readback changed beyond the rejected/unknown statement's expected prior state.`;
          break;
        }
        step.error = `${step.error ? `${step.error}; ` : ""}Readback index names: ${after.indexes.map((item) => item.name).join(", ") || "none"}.`;
        break;
      }
      if (JSON.stringify(after.indexNames) !== JSON.stringify(mutation.expectedOwnerNamesAfter)) {
        step.state = "unknown";
        step.error = "Readback owner index names did not match the expected result.";
        break;
      }
      if (!sameExpectedIndexes(after.indexes, mutation.expectedAfter)) {
        step.state = "unknown";
        step.error = `Readback did not match the expected ${mutation.operation} definition for ${mutation.name}.`;
        break;
      }
    } catch (error) {
      step.state = "unknown";
      step.error = `${step.error ? `${step.error}; ` : ""}${error instanceof Error ? error.message : String(error)}`;
      return { steps, readbackError: "Index DDL was attempted but immediate catalog readback failed; outcome is unknown." };
    }
  }
  return { steps };
}
