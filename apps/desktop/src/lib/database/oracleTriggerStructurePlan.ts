import * as api from "@/lib/backend/api";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { exactOracleTriggerMetadata } from "./oracleTriggerIdentity";
import { assertTriggerStructureSql, prepareOracleTriggerPlan, readOracleTriggerSnapshot, type OracleTriggerPlan, type OracleTriggerPlanInput, type OracleTriggerTarget } from "./oracleTriggerPlan";
import { oracleTriggerDefinitionScopes, type OracleTriggerDatabaseType } from "./oracleTriggerSql";
import type { EditableStructureTrigger, OracleTriggerStructureOperation } from "@/lib/table/tableStructureEditorSql";
import { useConnectionStore } from "@/stores/connectionStore";
import { buildTriggerToggleSql } from "./triggerToggleSql";
import { inspectExactOracleTriggerSource } from "@/lib/table/objectSourceLoad";
import type { ColumnInfo, ConstraintInfo, ForeignKeyInfo, IndexInfo, TableStructureEditorDraft, TriggerInfo } from "@/types/database";
import { createColumnDrafts, createForeignKeyDrafts, createIndexDrafts, createTriggerDrafts, foldCreatedTableName } from "@/lib/table/tableStructureEditorState";

export interface OracleTriggerStructureTarget extends Omit<OracleTriggerTarget, "name"> {
  tableName: string;
  parentType: "TABLE" | "VIEW";
  databaseType: OracleTriggerDatabaseType;
  newTable: boolean;
}
export interface OracleTriggerStructureGroup {
  operation: Readonly<OracleTriggerStructureOperation>;
  plan?: OracleTriggerPlan;
  /** A new table has no object ID before CREATE TABLE. Verify it before sending its trigger. */
  afterTableCreate?: Readonly<OracleTriggerPlanInput>;
}
export interface OracleTriggerStructurePlan {
  target: Readonly<OracleTriggerStructureTarget>;
  statements: readonly string[];
  groups: readonly Readonly<OracleTriggerStructureGroup>[];
  revision: number;
  configFingerprint: string;
}

export async function prepareOracleTriggerStructurePlan(input: { target: OracleTriggerStructureTarget; statements: readonly string[]; operations: readonly OracleTriggerStructureOperation[]; triggers: readonly EditableStructureTrigger[] }): Promise<OracleTriggerStructurePlan> {
  const target = Object.freeze({ ...input.target });
  const statements = Object.freeze([...input.statements]);
  const drafts: EditableStructureTrigger[] = JSON.parse(JSON.stringify(input.triggers));
  const operations = input.operations.map((operation) => Object.freeze({ ...operation }));
  const store = useConnectionStore();
  const revision = store.connectionStateRevision(target.connectionId);
  const config = store.getConfig(target.connectionId);
  if (!config || !store.connectedIds.has(target.connectionId)) throw new Error("Reconnect before preparing the table/trigger preview");
  const fingerprint = connectionConfigFingerprint(config);
  const groups: OracleTriggerStructureGroup[] = [];
  let end = 0;
  for (const operation of operations) {
    const draft = drafts.find((item) => item.id === operation.draftId);
    if (
      !draft?.oracleExact ||
      draft.oracleExact.owner !== operation.owner ||
      !Number.isInteger(operation.statementIndex) ||
      !Number.isInteger(operation.statementCount) ||
      operation.statementIndex < end ||
      operation.statementCount < 1 ||
      operation.statementIndex + operation.statementCount > statements.length
    )
      throw new Error("Regenerate the trigger operation mapping before saving");
    end = operation.statementIndex + operation.statementCount;
    const expectedName = operation.action === "create" ? (target.newTable ? foldCreatedTableName(draft.name, target.databaseType) : draft.name.trim()) : draft.original?.name;
    if (operation.name !== expectedName) throw new Error("The generated trigger target differs from its table draft");
    const selected = Object.freeze({ scope: draft.oracleExact.parentType, owner: target.owner, name: target.tableName, pluggable: false } as const);
    const triggerTarget: OracleTriggerTarget = Object.freeze({ connectionId: target.connectionId, database: target.database, catalog: target.catalog, owner: operation.owner, name: operation.name, executionSchema: target.executionSchema });
    const before = await readOracleTriggerSnapshot(triggerTarget);
    if (operation.action !== "create") {
      const loaded = exactOracleTriggerMetadata(draft.original);
      const actual = before.metadata;
      // This fresh snapshot cannot silently replace the version the form loaded.
      if (
        !loaded ||
        loaded.objectId !== actual.objectId ||
        loaded.owner !== actual.owner ||
        loaded.name !== actual.name ||
        loaded.scope !== actual.scope ||
        loaded.lastDdlTime !== actual.lastDdlTime ||
        JSON.stringify(loaded.parent) !== JSON.stringify(actual.parent) ||
        draft.original?.enabled !== before.raw.trigger?.enabled ||
        draft.original?.statement !== before.raw.trigger?.statement ||
        draft.original?.timing !== before.raw.trigger?.timing ||
        draft.original?.event !== before.raw.trigger?.event ||
        draft.original?.condition !== before.raw.trigger?.condition
      )
        throw new Error("The trigger changed since the table draft was loaded; keep the draft and reread it");
      if ((operation.action === "replace" || (operation.action === "delete" && !draft.markedForDrop)) && (draft.loadedOracleSource === undefined || draft.loadedOracleSource !== before.raw.source))
        throw new Error("Reload the complete trigger baseline before applying a structured edit; the current draft is retained");
      if (operation.action === "replace" || (operation.action === "delete" && !draft.markedForDrop)) {
        const inspected = await inspectExactOracleTriggerSource(before.raw, operation.owner, operation.name);
        if (!inspected.triggerSource.complete || inspected.triggerSource.prepared?.structuredEditable !== true) throw new Error("Edit the complete trigger source to preserve clauses outside the structured form");
      }
    }
    const request: OracleTriggerPlanInput = {
      target: triggerTarget,
      action: operation.action,
      ...(operation.action === "replace" ? { baseline: before } : {}),
      ...(operation.action === "create" || operation.action === "replace" ? { source: statements[operation.statementIndex], selection: selected, enabled: operation.enabled } : {}),
      expectedObjectId: operation.action === "create" || typeof before.metadata.objectId !== "string" ? undefined : before.metadata.objectId,
    };
    if (target.newTable && operation.action === "create") {
      if (before.exists || !oracleTriggerDefinitionScopes(before.metadata).includes(selected.scope)) throw new Error("The new trigger target or engine profile is unavailable");
      const prepared = await api.prepareOracleTriggerSql({ databaseType: target.databaseType, owner: operation.owner, name: operation.name, source: request.source!, purpose: "create", binding: selected, enabled: operation.enabled });
      const expected = [prepared.definition];
      if (prepared.requiresStateRestore) {
        const disable = buildTriggerToggleSql({ databaseType: target.databaseType, schema: operation.owner, triggerName: operation.name, enabled: false, identityMode: "exact", scope: selected.scope });
        if (!disable) throw new Error("The trigger's native state restoration is unavailable");
        expected.push(disable);
      }
      if (expected.length !== operation.statementCount || expected.some((sql, index) => sql !== statements[operation.statementIndex + index])) throw new Error("The trigger SQL no longer matches the table preview");
      groups.push({ operation, afterTableCreate: Object.freeze(request) });
    } else {
      const plan = await prepareOracleTriggerPlan(request);
      assertTriggerStructureSql(statements, operation, plan);
      groups.push({ operation, plan });
    }
  }
  const latest = store.getConfig(target.connectionId);
  if (!latest || !store.isCurrentConnectionStateRevision(target.connectionId, revision) || store.connectionStateRevision(target.connectionId) !== revision || connectionConfigFingerprint(latest) !== fingerprint) throw new Error("The connection changed; regenerate the table preview");
  return Object.freeze({ target, statements, groups: Object.freeze(groups.map((group) => Object.freeze(group))), revision, configFingerprint: fingerprint });
}

/** Explicit read/reconcile keeps the desired values; it never dispatches the saved SQL array. */
export function reconcileOracleTriggerStructureDraft(
  draft: TableStructureEditorDraft,
  current: { columns: ColumnInfo[]; indexes: IndexInfo[]; foreignKeys: ForeignKeyInfo[]; triggers: TriggerInfo[]; constraints: ConstraintInfo[]; comment: string },
  changed: { columns: Set<string>; indexes: Set<string>; foreignKeys: Set<string>; triggers: Set<string> },
  databaseType: OracleTriggerDatabaseType,
): TableStructureEditorDraft {
  const rebase = <T extends { id: string; name: string; original?: { name: string }; markedForDrop: boolean }>(pending: T[], actual: T[], edits: Set<string>, matches?: (item: T, row: T, original: boolean) => boolean): T[] => {
    const used = new Set<T>();
    const remaining: T[] = [];
    for (const item of pending) {
      const old = item.original && actual.find((row) => (matches ? matches(item, row, true) : row.name === item.original!.name));
      const names = new Set([item.name, foldCreatedTableName(item.name, databaseType)]);
      const candidates = actual.filter((row) => (matches ? matches(item, row, false) : names.has(row.name)));
      const next = candidates.find((row) => row !== old) ?? candidates[0];
      if ((old && next && old !== next) || candidates.length > 1) throw new Error(`Both names are present: ${item.original?.name ?? item.name} / ${item.name}. Resolve the name conflict before reconciling.`);
      const found = old || next;
      if (found) used.add(found);
      if (!edits.has(item.id)) {
        if (found) remaining.push({ ...found, id: item.id });
      } else if (!(item.markedForDrop && !found)) {
        const merged = { ...item, original: found?.original };
        if (found && candidates.includes(found) && found !== old) merged.name = found.name;
        remaining.push(merged);
      }
    }
    return [...remaining, ...actual.filter((row) => !used.has(row))];
  };
  const actualTriggers = createTriggerDrafts(current.triggers);
  const triggers = rebase(draft.triggers, actualTriggers, changed.triggers, (item, row, original) => {
    const owner = item.oracleExact?.owner ?? exactOracleTriggerMetadata(item.original)?.owner;
    if (owner !== exactOracleTriggerMetadata(row.original)?.owner) return false;
    const name = original || item.original?.name === item.name ? item.original!.name : draft.newTableName ? foldCreatedTableName(item.name, databaseType) : item.name.trim();
    return row.name === name;
  }).map((trigger) => {
    const previous = draft.triggers.find((item) => item.id === trigger.id);
    const metadata = exactOracleTriggerMetadata(previous?.original);
    const oracleExact = trigger.oracleExact ?? (metadata && (metadata.scope === "TABLE" || metadata.scope === "VIEW") ? { owner: metadata.owner, parentType: metadata.scope } : undefined);
    const bodyEdited = previous?.original && (previous.statement !== previous.original.statement || previous.timing !== previous.original.timing || previous.event !== previous.original.event);
    if (previous?.original && !bodyEdited && trigger.original) return { ...trigger, oracleExact, statement: trigger.original.statement ?? "", timing: trigger.original.timing, event: trigger.original.event, loadedOracleSource: undefined, loadedOracleStructured: undefined };
    return { ...trigger, oracleExact, loadedOracleSource: undefined, loadedOracleStructured: undefined };
  });
  return {
    ...draft,
    columns: rebase(draft.columns, createColumnDrafts(current.columns, databaseType), changed.columns),
    indexes: rebase(draft.indexes, createIndexDrafts(current.indexes), changed.indexes),
    foreignKeys: rebase(draft.foreignKeys, createForeignKeyDrafts(current.foreignKeys, databaseType), changed.foreignKeys),
    triggers,
    constraints: current.constraints,
    originalTableComment: current.comment,
    oracleTriggerStructureRecovery: undefined,
  };
}
