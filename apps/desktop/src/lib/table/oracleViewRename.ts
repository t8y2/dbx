import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { OracleViewRenameIssue, OracleViewRenameSource } from "@/types/database";
import type { QueryResult } from "@/types/database";

export interface OracleViewRenameTarget {
  connectionId: string;
  database: string;
  schema: string;
  oldName: string;
  newName: string;
}

interface ViewSnapshot {
  name: string;
  source: string;
  fingerprint: string;
  rewrittenSource: string;
  rewrittenFingerprint: string;
  grants: string;
  draft: string;
  references: { owner: string; name: string }[];
}

export interface OracleViewRenameStep {
  kind: "replace" | "rename";
  viewName: string;
  sql: string;
  expectedFingerprint?: string;
}

export interface OracleViewRenamePlan {
  target: OracleViewRenameTarget;
  canonicalNewName: string;
  coverage: "visible-only";
  statements: string[];
  views: ViewSnapshot[];
  dependencyEdges: string[];
  issues: OracleViewRenameIssue[];
  metadataComplete: boolean;
  executable: boolean;
  steps: OracleViewRenameStep[];
}

export class OracleViewRenameFailure extends Error {
  constructor(
    public readonly plan: OracleViewRenamePlan,
    public readonly completed: string[],
    public readonly uncertain: string,
    cause: unknown,
  ) {
    super(`View rename stopped. Confirmed: ${completed.join(", ") || "none"}. Check the database state of ${uncertain} before retrying. ${String(cause instanceof Error ? cause.message : cause)}`);
  }
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const metadataLimit = 5000;

async function query(target: OracleViewRenameTarget, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { maxRows: metadataLimit + 1 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Metadata query failed.");
  if (result.truncated || result.has_more || result.rows.length > metadataLimit || result.large_value_cells?.length) {
    throw new Error("Metadata is incomplete; refresh with a complete definition before renaming.");
  }
  return result;
}

async function checkOwner(target: OracleViewRenameTarget) {
  const result = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
  if (result.rows.length !== 1 || result.rows[0][0] !== target.schema || result.rows[0][1] !== target.schema) {
    throw new Error("View rename requires the object's owner and matching current schema.");
  }
}

async function objectState(target: OracleViewRenameTarget, name: string) {
  return (await query(target, `SELECT OBJECT_TYPE, STATUS FROM USER_OBJECTS WHERE OBJECT_NAME=${literal(name)} AND OBJECT_TYPE IN ('TABLE','VIEW','SEQUENCE','SYNONYM','PROCEDURE','FUNCTION','PACKAGE','MATERIALIZED VIEW','TYPE','OPERATOR')`)).rows;
}

async function readSource(target: OracleViewRenameTarget, name: string): Promise<string> {
  const ddl = `DBMS_METADATA.GET_DDL('VIEW',${literal(name)},${literal(target.schema)})`;
  const lengthRows = (await query(target, `SELECT DBMS_LOB.GETLENGTH(${ddl}) FROM DUAL`)).rows;
  const length = Number(lengthRows[0]?.[0]);
  if (lengthRows.length !== 1 || !Number.isSafeInteger(length) || length <= 0 || length > 1_000_000) throw new Error(`Complete DDL is unavailable for ${name}.`);
  let source = "";
  for (let firstOffset = 1; firstOffset <= length; firstOffset += 32_000) {
    const offsets: number[] = [];
    for (let offset = firstOffset; offset <= length && offsets.length < 32; offset += 1000) offsets.push(offset);
    const sql = offsets.map((offset) => `SELECT ${offset} CHUNK_OFFSET, DBMS_LOB.SUBSTR(${ddl},1000,${offset}) CHUNK_TEXT FROM DUAL`).join(" UNION ALL ");
    const rows = (await query(target, sql)).rows;
    const chunks = new Map(rows.map((row) => [Number(row[0]), row[1]]));
    if (rows.length !== offsets.length || chunks.size !== offsets.length) throw new Error(`Complete DDL is unavailable for ${name}.`);
    for (const offset of offsets) {
      const chunk = chunks.get(offset);
      if (typeof chunk !== "string" || Array.from(chunk).length !== Math.min(1000, length - offset + 1)) throw new Error(`Complete DDL is unavailable for ${name}.`);
      source += chunk;
    }
  }
  return source;
}

async function readGrants(target: OracleViewRenameTarget, name: string): Promise<string> {
  const tables = await query(target, `SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  const columns = await query(target, `SELECT GRANTOR, GRANTEE, COLUMN_NAME, PRIVILEGE, GRANTABLE FROM ALL_COL_PRIVS WHERE OWNER=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  return JSON.stringify([tables.rows.map((row) => JSON.stringify(row)).sort(), columns.rows.map((row) => JSON.stringify(row)).sort()]);
}

async function readDependents(target: OracleViewRenameTarget, name: string) {
  const suffix = ` WHERE REFERENCED_OWNER=${literal(target.schema)} AND REFERENCED_NAME=${literal(name)} AND REFERENCED_TYPE='VIEW'`;
  const columns = "SELECT OWNER, NAME, TYPE, REFERENCED_LINK_NAME FROM ";
  try {
    return (await query(target, `${columns}SYS.DBA_DEPENDENCIES${suffix}`)).rows;
  } catch (error) {
    // Only a denied dictionary is a fallback. Timeouts and incomplete results
    // must never turn a known dependency graph into an empty successful plan.
    if (!/ORA-00942|ORA-01031/.test(String(error instanceof Error ? error.message : error))) throw error;
    return (await query(target, `${columns}SYS.ALL_DEPENDENCIES${suffix}`)).rows;
  }
}

function issue(code: string, message: string, viewName?: string, repairable = false): OracleViewRenameIssue {
  return { code, message, viewName, repairable };
}

export async function prepareOracleViewRename(target: OracleViewRenameTarget, drafts: Record<string, string> = {}): Promise<OracleViewRenamePlan> {
  target = { ...target };
  const issues: OracleViewRenameIssue[] = [];
  let canonicalNewName = target.newName;
  let metadataComplete = true;
  try {
    canonicalNewName = await api.parseOracleObjectName(target.newName);
    if (canonicalNewName === target.oldName) issues.push(issue("invalid_name", "The new name matches the existing name."));
    await checkOwner(target);
    if ((await objectState(target, canonicalNewName)).length) issues.push(issue("target_conflict", `An object named ${canonicalNewName} already exists.`));
  } catch (error) {
    metadataComplete = false;
    const message = String(error);
    const code = /owner|current schema/i.test(message) ? "owner_mismatch" : /missing or invalid/i.test(message) ? "invalid_object" : "metadata_incomplete";
    issues.push(issue(code, message));
  }
  const ordered: string[] = [];
  const edges: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = async (name: string) => {
    if (visiting.has(name)) {
      issues.push(issue("dependency_cycle", `Cyclic view dependency: ${name}.`, name));
      return;
    }
    if (visited.has(name)) return;
    if (visited.size + visiting.size >= metadataLimit) throw new Error("Dependency graph is incomplete: too many views.");
    visiting.add(name);
    let dependents: unknown[][];
    try {
      dependents = await readDependents(target, name);
    } catch (error) {
      metadataComplete = false;
      issues.push(issue("dependency_read_failed", String(error), name));
      visiting.delete(name);
      visited.add(name);
      ordered.push(name);
      return;
    }
    for (const row of [...dependents].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0))) {
      const [owner, dependent, kind, link] = row;
      if (owner !== target.schema || kind !== "VIEW" || link || typeof dependent !== "string") {
        issues.push(issue("dependency_scope", `Cannot automatically update dependent ${String(owner)}.${String(dependent)} (${String(kind)}).`, typeof dependent === "string" ? dependent : name));
        continue;
      }
      edges.push(JSON.stringify([name, dependent]));
      await walk(dependent);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  };
  if (metadataComplete) await walk(target.oldName);
  ordered.reverse();

  const views: ViewSnapshot[] = [];
  for (const name of ordered) {
    let source = "";
    let grants = "";
    try {
      const state = await objectState(target, name);
      if (state.length !== 1 || state[0][0] !== "VIEW" || state[0][1] !== "VALID") throw new Error(`View ${name} is missing or invalid.`);
      source = await readSource(target, name);
      grants = await readGrants(target, name);
    } catch (error) {
      metadataComplete = false;
      issues.push(issue("source_read_failed", String(error), name));
    }
    const draft = drafts[name] ?? source;
    const reviewInput = { source: draft, owner: target.schema, viewName: name, oldName: target.oldName, newName: target.oldName };
    let originalReview: Awaited<ReturnType<typeof api.reviewOracleViewRenameSource>> = { source: null, references: [], issues: [] };
    let review: Awaited<ReturnType<typeof api.reviewOracleViewRenameSource>> = { source: null, references: [], issues: [] };
    if (draft) {
      try {
        originalReview = await api.reviewOracleViewRenameSource({ ...reviewInput, source });
      } catch (error) {
        issues.push(issue("metadata_incomplete", String(error), name));
      }
      try {
        review = await api.reviewOracleViewRenameSource({ ...reviewInput, newName: canonicalNewName, ...(name === target.oldName ? { targetViewName: canonicalNewName } : {}) });
      } catch (error) {
        issues.push(issue("metadata_incomplete", String(error), name));
      }
    }
    const draftIssues = review.issues.map((item) => ({ ...item, viewName: name }));
    issues.push(...draftIssues);
    const original: OracleViewRenameSource | null = originalReview.source;
    const rewritten: OracleViewRenameSource | null = review.source;
    const normalize = (refs: OracleViewRenameSource["references"]) => refs.map((ref) => JSON.stringify([ref.owner, ref.name === canonicalNewName ? target.oldName : ref.name])).sort();
    const originalParseFailed = !original && originalReview.issues.some((item) => item.code === "invalid_definition" || item.code === "invalid_declaration");
    if (originalParseFailed) {
      const plannedNames = new Set([target.oldName, ...ordered.filter((plannedName) => plannedName !== target.oldName)]);
      const expected = edges
        .map((edge) => JSON.parse(edge) as [string, string])
        .filter(([, dependent]) => dependent === name)
        .map(([referenced]) => JSON.stringify([target.schema, referenced]))
        .sort();
      const actual = review.references
        .filter((reference) => reference.owner === target.schema && plannedNames.has(reference.name === canonicalNewName ? target.oldName : reference.name))
        .map((reference) => JSON.stringify([reference.owner, reference.name === canonicalNewName ? target.oldName : reference.name]))
        .sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) issues.push(issue("manual_graph", `The proposed definition changes planned dependencies of ${name}.`, name, true));
    } else if (JSON.stringify(normalize(originalReview.references)) !== JSON.stringify(normalize(review.references))) {
      issues.push(issue("manual_graph", `The proposed definition changes dependencies of ${name}.`, name, true));
    }
    if (rewritten) {
      views.push({ name, source, fingerprint: original?.fingerprint || "", rewrittenSource: rewritten.source, rewrittenFingerprint: rewritten.fingerprint, grants, draft, references: originalReview.references });
    } else {
      views.push({ name, source, fingerprint: original?.fingerprint || "", rewrittenSource: "", rewrittenFingerprint: "", grants, draft, references: originalReview.references });
    }
  }
  const rootDrafted = Boolean(drafts[target.oldName] && drafts[target.oldName] !== views.find((view) => view.name === target.oldName)?.source);
  const steps: OracleViewRenameStep[] = [];
  if (rootDrafted) {
    const root = views.find((view) => view.name === target.oldName);
    const beforeRename = await api.reviewOracleViewRenameSource({ source: root?.draft || "", owner: target.schema, viewName: target.oldName, oldName: target.oldName, newName: target.oldName, targetViewName: target.oldName });
    issues.push(...beforeRename.issues.map((item) => ({ ...item, viewName: target.oldName })));
    if (beforeRename.source) steps.push({ kind: "replace", viewName: target.oldName, sql: beforeRename.source.source, expectedFingerprint: beforeRename.source.fingerprint });
  }
  steps.push({ kind: "rename", viewName: target.oldName, sql: `RENAME ${identifier(target.oldName)} TO ${identifier(canonicalNewName)};` });
  for (const view of views) if (view.name !== target.oldName && view.rewrittenSource) steps.push({ kind: "replace", viewName: view.name, sql: view.rewrittenSource, expectedFingerprint: view.rewrittenFingerprint });
  const executable = metadataComplete && issues.length === 0 && views.length > 0 && views.every((view) => Boolean(view.rewrittenSource));
  return {
    target,
    canonicalNewName,
    coverage: "visible-only",
    views,
    dependencyEdges: [...new Set(edges)].sort(),
    statements: steps.map((step) => step.sql),
    issues,
    metadataComplete,
    executable,
    steps,
  };
}

function planIdentity(plan: OracleViewRenamePlan) {
  return JSON.stringify([plan.target, plan.canonicalNewName, plan.dependencyEdges, plan.issues, plan.metadataComplete, plan.views.map((view) => [view.name, view.source, view.grants, view.draft, view.rewrittenFingerprint]), plan.steps]);
}

export async function executeOracleViewRename(plan: OracleViewRenamePlan, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error("The rename target changed. Refresh the preview.");
  if (!plan.executable) throw new Error("Fix and validate the view definitions before execution.");
  const current = await prepareOracleViewRename(plan.target, Object.fromEntries(plan.views.map((view) => [view.name, view.draft])));
  if (!current.executable) throw new Error("The rename target or its dependencies changed or no longer pass validation. Refresh the preview.");
  if (!isCurrent() || planIdentity(current) !== planIdentity(plan)) throw new Error("The rename target or its dependencies changed. Refresh the preview.");
  const frozen = freezeSourceIdentities(
    plan.views.map((view) => ({
      connectionId: plan.target.connectionId,
      database: plan.target.database,
      schema: plan.target.schema,
      objectType: "VIEW" as const,
      name: view.name,
    })),
  );
  const completed: string[] = [];
  let dispatched = false;
  let activeName = plan.target.oldName;
  try {
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      const view = plan.views.find((item) => item.name === step.viewName)!;
      activeName = step.kind === "rename" ? plan.canonicalNewName : step.viewName;
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      if (step.kind === "replace") {
        const source = await readSource(plan.target, view.name);
        if (source !== view.source || (await readGrants(plan.target, view.name)) !== view.grants) throw new Error(`View ${view.name} changed during rename; its definition was not overwritten.`);
        if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      }
      if (!dispatched) {
        frozen.markDispatched();
        dispatched = true;
      }
      await query(plan.target, step.sql);
      if (step.kind === "replace" && step.viewName === plan.target.oldName) {
        const state = await objectState(plan.target, plan.target.oldName);
        const replaced = await readSource(plan.target, plan.target.oldName);
        const actualBeforeRename = await api.reviewOracleViewRenameSource({ source: replaced, owner: plan.target.schema, viewName: plan.target.oldName, oldName: plan.target.oldName, newName: plan.target.oldName, targetViewName: plan.target.oldName });
        if (state.length !== 1 || actualBeforeRename.source?.fingerprint !== step.expectedFingerprint) throw new Error(`View ${plan.target.oldName} did not match its validated replacement.`);
        completed.push(`${plan.target.oldName} (definition replaced)`);
        continue;
      }
      if (step.kind === "rename") {
        const state = await objectState(plan.target, activeName);
        if (state.length !== 1 || state[0][0] !== "VIEW" || state[0][1] !== "VALID") throw new Error(`View ${activeName} is not valid after the change.`);
        const source = await readSource(plan.target, activeName);
        const actual = await api.reviewOracleViewRenameSource({ source, owner: plan.target.schema, viewName: activeName, oldName: plan.canonicalNewName, newName: plan.canonicalNewName });
        const root = plan.views.find((item) => item.name === plan.target.oldName)!;
        if (actual.source?.fingerprint !== root.rewrittenFingerprint || (await readGrants(plan.target, activeName)) !== root.grants) throw new Error(`Definition or grants did not match the preview for ${activeName}.`);
        if ((await objectState(plan.target, plan.target.oldName)).length) throw new Error("The old view name still exists after rename.");
        completed.push(activeName);
        continue;
      }
      const state = await objectState(plan.target, activeName);
      if (state.length !== 1 || state[0][0] !== "VIEW" || state[0][1] !== "VALID") throw new Error(`View ${activeName} is not valid after the change.`);
      const source = await readSource(plan.target, activeName);
      const actual = await api.reviewOracleViewRenameSource({ source, owner: plan.target.schema, viewName: activeName, oldName: plan.canonicalNewName, newName: plan.canonicalNewName });
      if (actual.source?.fingerprint !== view.rewrittenFingerprint || (await readGrants(plan.target, activeName)) !== view.grants) throw new Error(`Definition or grants did not match the preview for ${activeName}.`);
      completed.push(activeName);
    }
  } catch (error) {
    if (dispatched) throw new OracleViewRenameFailure(plan, completed, activeName, error);
    throw error;
  } finally {
    if (dispatched) {
      const scope = { connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema };
      invalidateObjectBrowserRowsCache(scope);
      await Promise.allSettled([...new Set([...plan.views.map((view) => view.name), plan.canonicalNewName])].map((tableName) => invalidateObjectDdlCache({ ...scope, tableName })));
      frozen.finish();
    } else frozen.cancel();
  }
}
