import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { DatabaseType, ObjectSourceKind, QueryResult } from "@/types/database";

export interface OracleRoutineRenameTarget {
  connectionId: string;
  database: string;
  databaseType: Extract<DatabaseType, "oracle" | "dameng" | "oceanbase-oracle">;
  schema: string;
  objectType: Extract<ObjectSourceKind, "PROCEDURE" | "FUNCTION">;
  oldName: string;
  newName: string;
}

interface RoutineSnapshot {
  name: string;
  objectType: string;
  objectId: string;
  status: string;
  source: string;
  signature: string;
  grants: string;
  errors: string;
}

interface RoutineCallerSnapshot extends RoutineSnapshot {
  draft: string;
  rewrittenSource: string;
  rewrittenFingerprint: string;
  sourceFingerprint: string;
  rewriteRequired: boolean;
  depth: number;
}

export type OracleRoutineRenameStep = {
  kind: "create" | "grant" | "replace-caller" | "compile-caller" | "drop";
  objectName: string;
  objectType: string;
  sql: string;
};

export interface OracleRoutineRenamePlan {
  target: OracleRoutineRenameTarget;
  canonicalNewName: string;
  root: RoutineSnapshot | null;
  rootDraft: string;
  rootCreateSource: string;
  callers: RoutineCallerSnapshot[];
  dependencyEdges: string[];
  statements: string[];
  steps: OracleRoutineRenameStep[];
  issues: Array<{ code: string; message: string; objectName?: string; repairable: boolean }>;
  metadataComplete: boolean;
  executable: boolean;
}

export class OracleRoutineRenameFailure extends Error {
  constructor(
    public readonly plan: OracleRoutineRenamePlan,
    public readonly completed: string[],
    public readonly uncertain: string,
    cause: unknown,
  ) {
    super(`Routine rename stopped. Confirmed: ${completed.join(", ") || "none"}. Check ${uncertain} before retrying. ${errorMessage(cause)}`);
  }
}

const metadataLimit = 5000;
const maxSourceLength = 1_000_000;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const routineTypes = new Set(["PROCEDURE", "FUNCTION"]);
const acceptedCallerTypes = new Set(["VIEW", "PROCEDURE", "FUNCTION"]);
const namespaceTypes = ["TABLE", "VIEW", "SEQUENCE", "SYNONYM", "PROCEDURE", "FUNCTION", "PACKAGE", "MATERIALIZED VIEW", "TYPE", "OPERATOR"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function qualified(schema: string, name: string) {
  return `${identifier(schema)}.${identifier(name)}`;
}

async function query(target: OracleRoutineRenameTarget, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { maxRows: metadataLimit + 1 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Metadata query failed.");
  if (result.truncated || result.has_more || result.rows.length > metadataLimit || result.large_value_cells?.length) {
    throw new Error("Metadata is incomplete; refresh the rename plan before execution.");
  }
  return result;
}

async function checkOwner(target: OracleRoutineRenameTarget) {
  const result = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
  if (result.rows.length !== 1 || result.rows[0][0] !== target.schema || result.rows[0][1] !== target.schema) {
    throw new Error("Routine rename requires the object's owner and matching current schema.");
  }
}

async function objectStates(target: OracleRoutineRenameTarget, names: string[], types = namespaceTypes) {
  if (!names.length) return [] as unknown[][];
  const list = names.map(literal).join(",");
  const objectTypes = types.map(literal).join(",");
  return (await query(target, `SELECT OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS FROM USER_OBJECTS WHERE OBJECT_NAME IN (${list}) AND OBJECT_TYPE IN (${objectTypes}) ORDER BY OBJECT_NAME, OBJECT_TYPE`)).rows;
}

async function readSource(target: OracleRoutineRenameTarget, objectType: string, name: string): Promise<string> {
  const metadataType = objectType === "PACKAGE BODY" ? "PACKAGE_BODY" : objectType;
  const ddl = `DBMS_METADATA.GET_DDL(${literal(metadataType)},${literal(name)},${literal(target.schema)})`;
  const lengthRows = (await query(target, `SELECT DBMS_LOB.GETLENGTH(${ddl}) FROM DUAL`)).rows;
  const length = Number(lengthRows[0]?.[0]);
  if (lengthRows.length !== 1 || !Number.isSafeInteger(length) || length <= 0 || length > maxSourceLength) {
    throw new Error(`Complete ${objectType} DDL is unavailable for ${name}.`);
  }
  let source = "";
  for (let firstOffset = 1; firstOffset <= length; firstOffset += 32_000) {
    const offsets: number[] = [];
    for (let offset = firstOffset; offset <= length && offsets.length < 32; offset += 1000) offsets.push(offset);
    const sql = offsets.map((offset) => `SELECT ${offset} CHUNK_OFFSET, DBMS_LOB.SUBSTR(${ddl},1000,${offset}) CHUNK_TEXT FROM DUAL`).join(" UNION ALL ");
    const rows = (await query(target, sql)).rows;
    const chunks = new Map(rows.map((row) => [Number(row[0]), row[1]]));
    if (rows.length !== offsets.length || chunks.size !== offsets.length) throw new Error(`Complete ${objectType} DDL is unavailable for ${name}.`);
    for (const offset of offsets) {
      const chunk = chunks.get(offset);
      if (typeof chunk !== "string" || Array.from(chunk).length !== Math.min(1000, length - offset + 1)) {
        throw new Error(`Complete ${objectType} DDL is unavailable for ${name}.`);
      }
      source += chunk;
    }
  }
  return source;
}

async function readSignature(target: OracleRoutineRenameTarget, name: string) {
  const rows = (
    await query(
      target,
      `SELECT POSITION, SEQUENCE, ARGUMENT_NAME, IN_OUT, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, TYPE_OWNER, TYPE_NAME, TYPE_SUBNAME, DEFAULTED FROM ALL_ARGUMENTS WHERE OWNER=${literal(target.schema)} AND OBJECT_NAME=${literal(name)} AND PACKAGE_NAME IS NULL ORDER BY OVERLOAD, SEQUENCE`,
    )
  ).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function readGrants(target: OracleRoutineRenameTarget, name: string) {
  const rows = (await query(target, `SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA=${literal(target.schema)} AND TABLE_NAME=${literal(name)} ORDER BY GRANTOR, GRANTEE, PRIVILEGE`)).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function readErrors(target: OracleRoutineRenameTarget, objectType: string, name: string) {
  const rows = (await query(target, `SELECT ATTRIBUTE, LINE, POSITION, TEXT FROM USER_ERRORS WHERE NAME=${literal(name)} AND TYPE=${literal(objectType)} ORDER BY SEQUENCE`)).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function validateCallerSource(target: OracleRoutineRenameTarget, callerType: string, callerName: string, renamedRoutineName: string, source: string) {
  if (callerType === "VIEW") {
    const review = await api.reviewOracleViewRenameSource({
      source,
      owner: target.schema,
      viewName: callerName,
      oldName: renamedRoutineName,
      newName: renamedRoutineName,
    });
    if (!review.source || review.issues.length) {
      throw new Error(review.issues.map(({ message }) => message).join("\n") || `Cannot validate view ${callerName}.`);
    }
    return review.source.source;
  }
  if (target.databaseType === "oracle" || target.databaseType === "oceanbase-oracle") {
    await api.validateOracleExecutableObjectSource({
      databaseType: target.databaseType,
      objectType: callerType as "PROCEDURE" | "FUNCTION",
      schema: target.schema,
      name: callerName,
      source,
    });
  }
  return source;
}

async function readSnapshot(target: OracleRoutineRenameTarget, name: string, objectType: string): Promise<RoutineSnapshot> {
  const rows = await objectStates(target, [name], [objectType]);
  const match = rows.filter((row) => row[0] === name && row[1] === objectType);
  if (match.length !== 1 || (typeof match[0][2] !== "number" && typeof match[0][2] !== "string")) {
    throw new Error(`${objectType} ${name} is missing or has an ambiguous identity.`);
  }
  return {
    name,
    objectType,
    objectId: String(match[0][2]),
    status: String(match[0][3]),
    source: await readSource(target, objectType, name),
    signature: routineTypes.has(objectType) ? await readSignature(target, name) : "",
    grants: await readGrants(target, name),
    errors: routineTypes.has(objectType) ? await readErrors(target, objectType, name) : "[]",
  };
}

async function readDependents(target: OracleRoutineRenameTarget, name: string, objectType: string) {
  const suffix = ` WHERE REFERENCED_OWNER=${literal(target.schema)} AND REFERENCED_NAME=${literal(name)} AND REFERENCED_TYPE=${literal(objectType)}`;
  const columns = "SELECT OWNER, NAME, TYPE, REFERENCED_LINK_NAME FROM ";
  try {
    return (await query(target, `${columns}SYS.DBA_DEPENDENCIES${suffix}`)).rows;
  } catch (error) {
    if (!/ORA-00942|ORA-01031/.test(errorMessage(error))) throw error;
    return (await query(target, `${columns}SYS.ALL_DEPENDENCIES${suffix}`)).rows;
  }
}

function issue(issues: OracleRoutineRenamePlan["issues"], code: string, message: string, objectName?: string, repairable = false) {
  issues.push({ code, message, objectName, repairable });
}

function makeCreateOnly(sql: string) {
  const create = /^(\s*CREATE\s+)OR\s+REPLACE\s+/i;
  if (!create.test(sql)) throw new Error("Routine DDL is not a CREATE OR REPLACE statement.");
  return sql.replace(create, "$1");
}

async function routineSourceFingerprint(target: OracleRoutineRenameTarget, objectType: Extract<ObjectSourceKind, "PROCEDURE" | "FUNCTION">, name: string, source: string) {
  if (target.databaseType !== "oracle" && target.databaseType !== "oceanbase-oracle") return source;
  return api.fingerprintOracleRoutineObjectSource({
    databaseType: target.databaseType,
    objectType,
    schema: target.schema,
    name,
    source,
  });
}

function makeGrantSql(target: OracleRoutineRenameTarget, grantRows: string) {
  const rows = JSON.parse(grantRows) as Array<Array<string | null>>;
  const statements: string[] = [];
  for (const [grantor, grantee, privilege, grantable] of rows) {
    if (grantor !== target.schema || privilege !== "EXECUTE" || !grantee) {
      throw new Error(`Cannot safely copy direct grant ${String(privilege)} from ${String(grantor)} to the new routine.`);
    }
    statements.push(`GRANT EXECUTE ON ${qualified(target.schema, target.newName)} TO ${grantee === "PUBLIC" ? "PUBLIC" : identifier(grantee)}${grantable === "YES" ? " WITH GRANT OPTION" : ""};`);
  }
  return statements;
}

function planIdentity(plan: OracleRoutineRenamePlan) {
  return JSON.stringify([plan.target, plan.canonicalNewName, plan.dependencyEdges, plan.root, plan.rootDraft, plan.rootCreateSource, plan.callers, plan.statements, plan.issues, plan.metadataComplete]);
}

function routineDrafts(plan: OracleRoutineRenamePlan) {
  return Object.fromEntries([[`${plan.target.objectType}:${plan.target.oldName}`, plan.rootDraft], ...plan.callers.map((caller) => [`${caller.objectType}:${caller.name}`, caller.draft])]);
}

export async function prepareOracleRoutineRename(target: OracleRoutineRenameTarget, drafts: Record<string, string> = {}): Promise<OracleRoutineRenamePlan> {
  target = { ...target };
  const plan: OracleRoutineRenamePlan = {
    target,
    canonicalNewName: target.newName,
    root: null,
    rootDraft: "",
    rootCreateSource: "",
    callers: [],
    dependencyEdges: [],
    statements: [],
    steps: [],
    issues: [],
    metadataComplete: true,
    executable: false,
  };
  try {
    plan.canonicalNewName = await api.parseOracleObjectName(target.newName);
    if (plan.canonicalNewName === target.oldName) issue(plan.issues, "invalid_name", "The new name matches the existing routine name.");
    await checkOwner(target);
    const conflicts = await objectStates(target, [plan.canonicalNewName]);
    if (conflicts.some((row) => row[0] === plan.canonicalNewName)) issue(plan.issues, "target_conflict", `A routine-namespace object named ${plan.canonicalNewName} already exists.`);
  } catch (error) {
    plan.metadataComplete = false;
    issue(plan.issues, /owner|current schema/i.test(errorMessage(error)) ? "owner_mismatch" : "metadata_incomplete", errorMessage(error));
  }

  try {
    plan.root = await readSnapshot(target, target.oldName, target.objectType);
    plan.rootDraft = drafts[`${target.objectType}:${target.oldName}`] ?? plan.root.source;
    if (plan.root.status !== "VALID") issue(plan.issues, "invalid_source", `The existing ${target.objectType} is ${plan.root.status}; resolve its compile errors before rename.`, target.oldName);
  } catch (error) {
    plan.metadataComplete = false;
    issue(plan.issues, "source_read_failed", errorMessage(error), target.oldName);
  }

  const callers = new Map<string, { name: string; type: string; depth: number; rewriteRequired: boolean }>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = async (referencedName: string, referencedType: string, depth: number): Promise<void> => {
    const referencedKey = `${referencedType}:${referencedName}`;
    if (visited.has(referencedKey)) return;
    if (visiting.has(referencedKey)) {
      issue(plan.issues, "dependency_cycle", `Cyclic dependency reaches ${referencedType} ${referencedName}.`, referencedName);
      return;
    }
    visiting.add(referencedKey);
    let dependents: unknown[][];
    try {
      dependents = await readDependents(target, referencedName, referencedType);
      if (dependents.length > metadataLimit) throw new Error("Dependency metadata is incomplete.");
    } catch (error) {
      plan.metadataComplete = false;
      issue(plan.issues, "dependency_read_failed", errorMessage(error), referencedName);
      visiting.delete(referencedKey);
      visited.add(referencedKey);
      return;
    }
    for (const [owner, name, type, link] of dependents) {
      if (typeof name !== "string" || typeof type !== "string") {
        issue(plan.issues, "invalid_dependency", `Dependency metadata for ${referencedType} ${referencedName} is incomplete.`, referencedName);
        continue;
      }
      const selfRecursive = owner === target.schema && name === referencedName && type === referencedType && !link;
      plan.dependencyEdges.push(JSON.stringify([referencedName, referencedType, owner, name, type, link ?? null]));
      if (selfRecursive) continue;
      if (owner !== target.schema || link || !acceptedCallerTypes.has(type)) {
        issue(plan.issues, "unsupported_dependency", `Cannot update dependent ${String(owner)}.${name} (${type}${link ? `@${String(link)}` : ""}).`, name);
        continue;
      }
      const callerKey = `${type}:${name}`;
      const existing = callers.get(callerKey);
      callers.set(callerKey, {
        name,
        type,
        depth: Math.min(existing?.depth ?? Number.MAX_SAFE_INTEGER, depth + 1),
        rewriteRequired: (existing?.rewriteRequired ?? false) || referencedName === target.oldName,
      });
      const childKey = callerKey;
      if (visiting.has(childKey)) {
        issue(plan.issues, "dependency_cycle", `Cyclic dependency reaches ${type} ${name}.`, name);
      } else if (!visited.has(childKey)) {
        await walk(name, type, depth + 1);
      }
    }
    visiting.delete(referencedKey);
    visited.add(referencedKey);
  };
  if (plan.metadataComplete) await walk(target.oldName, target.objectType, 0);
  plan.dependencyEdges.sort();

  const orderedCallers = topologicalCallers(callers, plan.dependencyEdges);
  if (orderedCallers.length !== callers.size) issue(plan.issues, "dependency_cycle", "The visible caller graph cannot be ordered safely.", target.oldName);
  for (const caller of orderedCallers) {
    let snapshot: RoutineSnapshot;
    try {
      snapshot = await readSnapshot(target, caller.name, caller.type);
      if (snapshot.status !== "VALID") throw new Error(`${caller.type} ${caller.name} is ${snapshot.status}.`);
    } catch (error) {
      plan.metadataComplete = false;
      issue(plan.issues, "source_read_failed", errorMessage(error), caller.name);
      continue;
    }
    const draft = drafts[`${caller.type}:${caller.name}`] ?? snapshot.source;
    let rewrittenSource = "";
    let replacementSql = "";
    let sourceFingerprint = "";
    try {
      if (caller.rewriteRequired) {
        rewrittenSource = await api.rewriteOracleRoutineReferences({
          databaseType: target.databaseType,
          callerType: caller.type as "VIEW" | "PROCEDURE" | "FUNCTION",
          targetType: target.objectType,
          schema: target.schema,
          oldName: target.oldName,
          newName: plan.canonicalNewName,
          source: draft,
        });
        rewrittenSource = await validateCallerSource(target, caller.type, caller.name, plan.canonicalNewName, rewrittenSource);
        const statements = await api.buildExecutableObjectSourceStatements({
          databaseType: target.databaseType,
          objectType: caller.type as ObjectSourceKind,
          schema: target.schema,
          name: caller.name,
          source: rewrittenSource,
        });
        if (statements.length !== 1 || !statements[0]?.trim()) throw new Error(`Cannot build one replacement statement for ${caller.type} ${caller.name}.`);
        replacementSql = statements[0];
        if (routineTypes.has(caller.type)) sourceFingerprint = await routineSourceFingerprint(target, caller.type as "PROCEDURE" | "FUNCTION", caller.name, replacementSql);
      } else {
        rewrittenSource = draft;
        replacementSql = draft;
      }
    } catch (error) {
      issue(plan.issues, "caller_rewrite_failed", errorMessage(error), caller.name, true);
    }
    plan.callers.push({ ...snapshot, draft, rewrittenSource, rewrittenFingerprint: replacementSql, sourceFingerprint, rewriteRequired: caller.rewriteRequired, depth: caller.depth });
  }

  let dropSql = "";
  if (plan.metadataComplete && plan.root) {
    try {
      const statements = await api.buildRoutineRenameObjectSourceStatements({
        databaseType: target.databaseType,
        objectType: target.objectType,
        schema: target.schema,
        name: target.oldName,
        newName: plan.canonicalNewName,
        source: plan.rootDraft,
      });
      if (statements.length !== 2) throw new Error("The routine rename builder returned an unexpected statement sequence.");
      plan.rootCreateSource = makeCreateOnly(statements[0]);
      dropSql = statements[1];
    } catch (error) {
      issue(plan.issues, "source_rewrite_failed", errorMessage(error), target.oldName, true);
    }
    try {
      const grants = makeGrantSql({ ...target, newName: plan.canonicalNewName }, plan.root.grants);
      if (plan.issues.length === 0 && plan.callers.every((caller) => !!caller.rewrittenSource && !!caller.rewrittenFingerprint)) {
        plan.steps = [
          { kind: "create", objectName: plan.canonicalNewName, objectType: target.objectType, sql: plan.rootCreateSource },
          ...grants.map((sql) => ({ kind: "grant" as const, objectName: plan.canonicalNewName, objectType: target.objectType, sql })),
          ...plan.callers.map((caller) => ({
            kind: caller.rewriteRequired ? ("replace-caller" as const) : ("compile-caller" as const),
            objectName: caller.name,
            objectType: caller.objectType,
            sql: caller.rewriteRequired ? caller.rewrittenFingerprint : `ALTER ${caller.objectType} ${qualified(target.schema, caller.name)} COMPILE`,
          })),
          { kind: "drop", objectName: target.oldName, objectType: target.objectType, sql: dropSql },
        ];
        plan.statements = plan.steps.map((step) => step.sql);
        plan.executable = true;
      }
    } catch (error) {
      issue(plan.issues, "plan_build_failed", errorMessage(error), target.oldName);
    }
  }
  plan.dependencyEdges.sort();
  return plan;
}

function topologicalCallers(callers: Map<string, { name: string; type: string; depth: number; rewriteRequired: boolean }>, dependencyEdges: string[]) {
  const indegree = new Map([...callers.keys()].map((key) => [key, 0]));
  const outgoing = new Map([...callers.keys()].map((key) => [key, new Set<string>()]));
  for (const edge of dependencyEdges) {
    const [referencedName, referencedType, , dependentName, dependentType, link] = JSON.parse(edge) as [string, string, string, string, string, string | null];
    const from = `${referencedType}:${referencedName}`;
    const to = `${dependentType}:${dependentName}`;
    if (link || from === to) continue;
    if (!callers.has(from) || !callers.has(to) || outgoing.get(from)!.has(to)) continue;
    outgoing.get(from)!.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  }
  const compare = (left: string, right: string) => {
    const a = callers.get(left)!;
    const b = callers.get(right)!;
    return a.depth - b.depth || a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
  };
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key)
    .sort(compare);
  const ordered: Array<{ name: string; type: string; depth: number; rewriteRequired: boolean }> = [];
  while (ready.length) {
    const key = ready.shift()!;
    ordered.push(callers.get(key)!);
    for (const dependent of outgoing.get(key)!) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort(compare);
      }
    }
  }
  return ordered;
}

export async function executeOracleRoutineRename(plan: OracleRoutineRenamePlan, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error("The rename target changed. Refresh the preview.");
  if (!plan.executable || !plan.root) throw new Error("Resolve every routine dependency issue before execution.");
  const current = await prepareOracleRoutineRename(plan.target, routineDrafts(plan));
  if (!current.executable || planIdentity(current) !== planIdentity(plan) || !isCurrent()) throw new Error("Routine metadata changed. Refresh the rename preview.");
  const affected = [plan.root, ...plan.callers];
  const frozen = freezeSourceIdentities(
    affected.map((item) => ({
      connectionId: plan.target.connectionId,
      database: plan.target.database,
      schema: plan.target.schema,
      objectType: item.objectType,
      name: item.name,
    })),
  );
  const completed: string[] = [];
  let dispatched = false;
  let activeName = plan.canonicalNewName;
  let createdRoot: RoutineSnapshot | null = null;
  try {
    for (const step of plan.steps) {
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      activeName = step.objectName;
      if (step.kind === "create") {
        if ((await objectStates(plan.target, [plan.canonicalNewName])).some((row) => row[0] === plan.canonicalNewName)) throw new Error("The new routine name was created by another session.");
      } else if (step.kind === "replace-caller" || step.kind === "compile-caller") {
        const caller = plan.callers.find((item) => item.name === step.objectName && item.objectType === step.objectType)!;
        const latest = await readSnapshot(plan.target, caller.name, caller.objectType);
        if (latest.objectId !== caller.objectId || latest.source !== caller.source || latest.signature !== caller.signature || latest.grants !== caller.grants) {
          throw new Error(`${caller.objectType} ${caller.name} changed after validation.`);
        }
      } else if (step.kind === "drop") {
        await verifyBeforeDrop(plan, createdRoot);
      }
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      if (!dispatched) {
        frozen.markDispatched();
        dispatched = true;
      }
      try {
        await query(plan.target, step.sql);
      } catch (error) {
        if (step.kind === "drop") {
          try {
            const oldState = await objectStates(plan.target, [plan.target.oldName], [plan.target.objectType]);
            if (!oldState.some((row) => row[0] === plan.target.oldName && row[1] === plan.target.objectType)) {
              completed.push(`DROP ${plan.target.oldName} (confirmed by readback)`);
              return;
            }
            throw new Error(`DROP response failed and ${plan.target.objectType} ${plan.target.oldName} still exists: ${errorMessage(error)}`);
          } catch (readbackError) {
            if (readbackError instanceof Error && readbackError.message.startsWith("DROP response failed")) throw readbackError;
            throw new Error(`DROP response failed and the old object state is unknown: ${errorMessage(readbackError)}`);
          }
        }
        throw error;
      }
      if (step.kind === "create") {
        const created = await readSnapshot(plan.target, plan.canonicalNewName, plan.target.objectType);
        if (created.objectId === plan.root.objectId) throw new Error("The new name resolved to the original routine identity.");
        const actualSource = await api.buildRoutineRenameObjectSourceStatements({
          databaseType: plan.target.databaseType,
          objectType: plan.target.objectType as ObjectSourceKind,
          schema: plan.target.schema,
          name: plan.canonicalNewName,
          newName: plan.target.oldName,
          source: created.source,
        });
        const plannedSource = await api.buildRoutineRenameObjectSourceStatements({
          databaseType: plan.target.databaseType,
          objectType: plan.target.objectType as ObjectSourceKind,
          schema: plan.target.schema,
          name: plan.target.oldName,
          newName: plan.target.oldName,
          source: plan.rootDraft,
        });
        if (actualSource.length !== 2 || plannedSource.length !== 2) throw new Error("The new routine source does not match the approved definition.");
        const actualDefinition = makeCreateOnly(actualSource[0]);
        const plannedDefinition = makeCreateOnly(plannedSource[0]);
        const matchesApprovedDefinition =
          plan.target.databaseType === "oracle" || plan.target.databaseType === "oceanbase-oracle"
            ? (await routineSourceFingerprint(plan.target, plan.target.objectType, plan.target.oldName, actualDefinition)) === (await routineSourceFingerprint(plan.target, plan.target.objectType, plan.target.oldName, plannedDefinition))
            : actualDefinition === plannedDefinition;
        if (!matchesApprovedDefinition) throw new Error("The new routine source does not match the approved definition.");
        if (created.status !== "VALID") {
          await query(plan.target, `ALTER ${plan.target.objectType} ${qualified(plan.target.schema, plan.canonicalNewName)} COMPILE`);
          const compiled = await readSnapshot(plan.target, plan.canonicalNewName, plan.target.objectType);
          if (compiled.objectId !== created.objectId || compiled.source !== created.source || compiled.signature !== created.signature || compiled.grants !== created.grants) throw new Error(`The new routine ${plan.canonicalNewName} changed during compilation.`);
          if (compiled.status !== "VALID" || compiled.errors !== "[]") throw new Error(`The new routine ${plan.canonicalNewName} remains invalid after one compile attempt.`);
          createdRoot = compiled;
        } else {
          createdRoot = created;
        }
        completed.push(`CREATE ${plan.canonicalNewName}`);
      } else if (step.kind === "grant") {
        completed.push(`GRANT ${plan.canonicalNewName}`);
      } else if (step.kind === "replace-caller" || step.kind === "compile-caller") {
        const caller = plan.callers.find((item) => item.name === step.objectName && item.objectType === step.objectType)!;
        const actual = await readSnapshot(plan.target, caller.name, caller.objectType);
        const replacedViewMayHaveNewIdentity = step.kind === "replace-caller" && caller.objectType === "VIEW";
        if (
          (!replacedViewMayHaveNewIdentity && actual.objectId !== caller.objectId) ||
          actual.grants !== caller.grants ||
          (step.kind === "replace-caller" && (actual.status !== "VALID" || actual.errors !== caller.errors)) ||
          (step.kind === "compile-caller" && (actual.status !== "VALID" || actual.errors !== "[]"))
        )
          throw new Error(`${caller.objectType} ${caller.name} did not preserve its identity, validity, errors, and grants.`);
        if (step.kind === "replace-caller") {
          await validateCallerSource(plan.target, caller.objectType, caller.name, plan.canonicalNewName, actual.source);
          const actualStatements = await api.buildExecutableObjectSourceStatements({
            databaseType: plan.target.databaseType,
            objectType: caller.objectType as ObjectSourceKind,
            schema: plan.target.schema,
            name: caller.name,
            source: actual.source,
          });
          const actualFingerprint = routineTypes.has(caller.objectType) ? await routineSourceFingerprint(plan.target, caller.objectType as "PROCEDURE" | "FUNCTION", caller.name, actual.source) : actualStatements[0];
          const expectedFingerprint = routineTypes.has(caller.objectType) ? caller.sourceFingerprint : caller.rewrittenFingerprint;
          if (actualStatements.length !== 1 || actualFingerprint !== expectedFingerprint) {
            throw new Error(`${caller.objectType} ${caller.name} did not match the planned replacement source.`);
          }
          if (replacedViewMayHaveNewIdentity) caller.objectId = actual.objectId;
        } else if (actual.source !== caller.source) {
          throw new Error(`${caller.objectType} ${caller.name} did not retain the planned caller source.`);
        }
        completed.push(`${caller.objectType} ${caller.name}`);
      } else {
        const oldState = await objectStates(plan.target, [plan.target.oldName], [plan.target.objectType]);
        if (oldState.some((row) => row[0] === plan.target.oldName && row[1] === plan.target.objectType)) throw new Error(`The old routine ${plan.target.oldName} still exists after DROP.`);
        completed.push(`DROP ${plan.target.oldName}`);
      }
    }
  } catch (error) {
    if (dispatched) throw new OracleRoutineRenameFailure(plan, completed, activeName, error);
    throw error;
  } finally {
    if (dispatched) {
      invalidateObjectBrowserRowsCache({ connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema });
      await Promise.allSettled([plan.target.oldName, plan.canonicalNewName, ...plan.callers.map((caller) => caller.name)].map((tableName) => invalidateObjectDdlCache({ connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema, tableName })));
      frozen.finish();
    } else frozen.cancel();
  }
}

async function verifyBeforeDrop(plan: OracleRoutineRenamePlan, createdRoot: RoutineSnapshot | null) {
  const root = await readSnapshot(plan.target, plan.target.oldName, plan.target.objectType);
  const created = await readSnapshot(plan.target, plan.canonicalNewName, plan.target.objectType);
  if (root.objectId !== plan.root!.objectId || root.source !== plan.root!.source || root.signature !== plan.root!.signature || root.grants !== plan.root!.grants || root.status !== plan.root!.status || root.errors !== plan.root!.errors) {
    throw new Error("The original routine changed before DROP.");
  }
  if (
    !createdRoot ||
    created.objectId !== createdRoot.objectId ||
    created.objectId === root.objectId ||
    created.source !== createdRoot.source ||
    created.status !== "VALID" ||
    created.errors !== "[]" ||
    created.signature !== plan.root!.signature ||
    created.grants !== makeGrantFingerprint(plan.root!.grants, plan.target.schema)
  )
    throw new Error("The new routine identity, source, signature, status, or grants changed before DROP.");
  for (const caller of plan.callers) {
    const actual = await readSnapshot(plan.target, caller.name, caller.objectType);
    if (actual.objectId !== caller.objectId || actual.status !== "VALID" || actual.errors !== caller.errors || actual.grants !== caller.grants) throw new Error(`Dependent ${caller.objectType} ${caller.name} changed before DROP.`);
    if (caller.rewriteRequired) {
      await validateCallerSource(plan.target, caller.objectType, caller.name, plan.canonicalNewName, actual.source);
      const actualStatements = await api.buildExecutableObjectSourceStatements({
        databaseType: plan.target.databaseType,
        objectType: caller.objectType as ObjectSourceKind,
        schema: plan.target.schema,
        name: caller.name,
        source: actual.source,
      });
      const actualFingerprint = routineTypes.has(caller.objectType) ? await routineSourceFingerprint(plan.target, caller.objectType as "PROCEDURE" | "FUNCTION", caller.name, actual.source) : actualStatements[0];
      const expectedFingerprint = routineTypes.has(caller.objectType) ? caller.sourceFingerprint : caller.rewrittenFingerprint;
      if (actualStatements.length !== 1 || actualFingerprint !== expectedFingerprint) {
        throw new Error(`Dependent ${caller.objectType} ${caller.name} no longer matches the planned rewrite.`);
      }
    } else if (actual.source !== caller.source) {
      throw new Error(`Transitive dependent ${caller.objectType} ${caller.name} changed before DROP.`);
    }
  }
  const selfEdge = JSON.stringify([plan.target.oldName, plan.target.objectType, plan.target.schema, plan.target.oldName, plan.target.objectType, null]);
  const expectedEdges = plan.dependencyEdges
    .map((edge) => {
      const [referencedName, referencedType, owner, name, type, link] = JSON.parse(edge) as [string, string, string, string, string, string | null];
      const isRootSelfEdge = referencedName === plan.target.oldName && referencedType === plan.target.objectType && owner === plan.target.schema && name === plan.target.oldName && type === plan.target.objectType;
      return JSON.stringify([referencedName === plan.target.oldName ? plan.canonicalNewName : referencedName, referencedType, owner, isRootSelfEdge ? plan.canonicalNewName : name, type, link]);
    })
    .sort();
  const references = new Map<string, { name: string; type: string }>();
  references.set(`${plan.canonicalNewName}:${plan.target.objectType}`, { name: plan.canonicalNewName, type: plan.target.objectType });
  for (const caller of plan.callers) references.set(`${caller.name}:${caller.objectType}`, { name: caller.name, type: caller.objectType });
  const actualEdges: string[] = [];
  for (const reference of references.values()) {
    for (const [owner, name, type, link] of await readDependents(plan.target, reference.name, reference.type)) {
      actualEdges.push(JSON.stringify([reference.name, reference.type, owner, name, type, link ?? null]));
    }
  }
  const oldDependencies = await readDependents(plan.target, plan.target.oldName, plan.target.objectType);
  const unplannedOldDependencies = oldDependencies.filter(([owner, name, type]) => !(owner === plan.target.schema && name === plan.target.oldName && type === plan.target.objectType));
  if (unplannedOldDependencies.length || JSON.stringify(actualEdges.sort()) !== JSON.stringify(expectedEdges)) throw new Error("The visible dependency closure changed before DROP.");
  if (plan.dependencyEdges.includes(selfEdge) && !oldDependencies.some(([owner, name, type]) => owner === plan.target.schema && name === plan.target.oldName && type === plan.target.objectType)) {
    throw new Error("The original recursive routine changed before DROP.");
  }
}

function makeGrantFingerprint(sourceFingerprint: string, schema: string) {
  const rows = JSON.parse(sourceFingerprint) as Array<Array<string | null>>;
  return JSON.stringify(rows.map(([, grantee, privilege, grantable]) => [schema, grantee, privilege, grantable]).map((row) => row.map((value) => (value === null ? null : String(value)))));
}
