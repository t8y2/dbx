import * as api from "@/lib/backend/api";
import type { DatabaseType, ObjectSource, QueryResult } from "@/types/database";
import { buildRoutineRenameObjectSourceStatements } from "@/lib/table/objectSourceEditor";

export function supportsPackageRename(databaseType: DatabaseType | undefined, objectType: string): boolean {
  return (databaseType === "oracle" || databaseType === "oceanbase-oracle") && (objectType === "PACKAGE" || objectType === "PACKAGE_BODY");
}

export interface PackageRenameContext {
  connectionId: string;
  database: string;
  databaseType: DatabaseType;
  schema: string;
  name: string;
  newName: string;
}

export interface PackageRenamePlan {
  context: PackageRenameContext;
  specification: string;
  body?: string;
  statements: string[];
  stages: string[];
  cleanup?: boolean;
  replacementSpecification?: string;
  replacementBody?: string;
}

function assertQuerySucceeded(result: QueryResult): QueryResult {
  if (result.execution_error) throw new Error(result.error?.detail || String(result.rows?.[0]?.[0] ?? "Package metadata query failed."));
  return result;
}

function validateSource(source: ObjectSource, context: PackageRenameContext, kind: "PACKAGE" | "PACKAGE_BODY"): string {
  if (source.name !== context.name || source.object_type !== kind || (source.schema && source.schema !== context.schema) || !source.source.trim()) {
    throw new Error("Package source identity is missing or differs from the selected object.");
  }
  return source.source;
}

/** A missing body is accepted only after an authoritative object-directory read. */
export async function preparePackageRename(context: PackageRenameContext, options?: { cleanup?: boolean; callersMigrated?: boolean }): Promise<PackageRenamePlan> {
  if (options?.cleanup && !options.callersMigrated) throw new Error("Confirm migration of external and dynamic callers before preparing original-package removal.");
  if (!supportsPackageRename(context.databaseType, "PACKAGE") || !context.schema || !context.newName || context.name === context.newName) throw new Error("Invalid package migration target.");
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const objects = assertQuerySucceeded(
    await api.executeQuery(context.connectionId, context.database, `SELECT OBJECT_TYPE FROM SYS.DBA_OBJECTS WHERE OWNER=${literal(context.schema)} AND OBJECT_NAME=${literal(context.name)} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY') ORDER BY OBJECT_TYPE`, context.schema),
  );
  const kinds = objects.rows.map((row) => String(row[0]));
  if (kinds.filter((kind) => kind === "PACKAGE").length !== 1 || kinds.filter((kind) => kind === "PACKAGE BODY").length > 1) throw new Error("The complete package identity is missing or ambiguous.");
  const specification = validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.name, "PACKAGE"), context, "PACKAGE");
  const body = kinds.includes("PACKAGE BODY") ? validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.name, "PACKAGE_BODY"), context, "PACKAGE_BODY") : undefined;
  let replacementSpecification: string | undefined;
  let replacementBody: string | undefined;
  if (options?.cleanup) {
    const replacement = assertQuerySucceeded(
      await api.executeQuery(context.connectionId, context.database, `SELECT OBJECT_TYPE FROM SYS.DBA_OBJECTS WHERE OWNER=${literal(context.schema)} AND OBJECT_NAME=${literal(context.newName)} AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY') ORDER BY OBJECT_TYPE`, context.schema),
    );
    if (JSON.stringify(replacement.rows.map((row) => String(row[0])).sort()) !== JSON.stringify([...kinds].sort())) throw new Error("Replacement specification/body pair differs from the original.");
    const target = { ...context, name: context.newName };
    replacementSpecification = validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.newName, "PACKAGE"), target, "PACKAGE");
    if (body !== undefined) replacementBody = validateSource(await api.getObjectSource(context.connectionId, context.database, context.schema, context.newName, "PACKAGE_BODY"), target, "PACKAGE_BODY");
  }
  const statements = await buildRoutineRenameObjectSourceStatements({
    databaseType: context.databaseType,
    objectType: "PACKAGE",
    schema: context.schema,
    name: context.name,
    newName: context.newName,
    source: specification,
    packageBodySource: body,
    ...(options?.cleanup ? { packageCleanup: true } : {}),
  });
  const stages = options?.cleanup ? ["verify and remove original package", "read back package identities"] : ["preflight", "create specification", ...(body !== undefined ? ["create body"] : []), "validate compilation and overloads", "copy and verify grants", "inspect remaining dependencies"];
  if (statements.length !== stages.length) throw new Error("The backend returned an incomplete package migration plan.");
  return { context, specification, body, statements, stages, ...(options?.cleanup ? { cleanup: true, replacementSpecification, replacementBody } : {}) };
}

export class PackageRenameStepError extends Error {
  constructor(
    readonly step: number,
    readonly stage: string,
    cause: unknown,
  ) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PackageRenameStepError";
  }
}

export function packageRenameRecoveryText(plan: PackageRenamePlan, completed: number, attempted?: number, error?: string, dependencies?: QueryResult, stageStates?: string[]): string {
  const comment = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => `-- ${line}`)
      .join("\n");
  return [
    plan.cleanup ? "-- Explicit package cleanup recovery. DDL is not transactional; determine old/new object state from readback." : "-- Package migration recovery snapshot. DDL is not transactional. The original package was not dropped by this plan.",
    comment(`${plan.context.schema}.${plan.context.name} -> ${plan.context.newName}`),
    ...plan.stages.map((stage, index) => comment(`${index + 1}. ${stage}: ${stageStates?.[index] ?? (index < completed ? "response received" : index === attempted ? "attempted; read back database state" : "not executed")}`)),
    ...(error ? [comment(error)] : []),
    ...(dependencies ? [comment(`${plan.cleanup ? "Cleanup readback" : "Remaining dependencies"}: ${JSON.stringify(dependencies.rows)}`)] : []),
    plan.cleanup ? "-- Original definitions below are recovery material, not an automatic rollback. Inspect actual state before repair." : "-- Review both names, compilation, grants and static/dynamic callers. Keep the original until callers are migrated.",
    "-- Any cleanup is a separate explicit operation. Inspect the replacement before deciding to repair or remove it.",
    "-- ORIGINAL SPECIFICATION",
    plan.specification,
    ...(plan.body !== undefined ? ["-- ORIGINAL BODY", plan.body] : []),
    ...(plan.replacementSpecification !== undefined ? ["-- REPLACEMENT SPECIFICATION", plan.replacementSpecification] : []),
    ...(plan.replacementBody !== undefined ? ["-- REPLACEMENT BODY", plan.replacementBody] : []),
    "-- PLANNED STATEMENTS",
    ...plan.statements,
  ].join("\n\n");
}

/** The caller obtains the existing production confirmation before entering here. */
export async function executePackageRename(
  plan: PackageRenamePlan,
  saveRecovery: (text: string) => void,
  execute: (sql: string) => Promise<QueryResult> = (sql) => api.executeQuery(plan.context.connectionId, plan.context.database, sql, plan.context.schema),
): Promise<{ migrationComplete: false; dependencies: QueryResult }> {
  const expected = plan.body !== undefined ? 6 : 5;
  if (plan.cleanup || plan.statements.length !== expected || plan.stages.length !== expected) throw new Error("Expected the complete package migration plan.");
  saveRecovery(packageRenameRecoveryText(plan, 0));
  let last!: QueryResult;
  for (let index = 0; index < plan.statements.length; index += 1) {
    saveRecovery(packageRenameRecoveryText(plan, index, index));
    try {
      last = assertQuerySucceeded(await execute(plan.statements[index]!));
      saveRecovery(packageRenameRecoveryText(plan, index + 1, undefined, undefined, index === plan.statements.length - 1 ? last : undefined));
    } catch (error) {
      const failure = new PackageRenameStepError(index + 1, plan.stages[index]!, error);
      saveRecovery(packageRenameRecoveryText(plan, index, index, failure.message));
      throw failure;
    }
  }
  return { migrationComplete: false, dependencies: last };
}

export class PackageRenameCleanupError extends PackageRenameStepError {
  constructor(
    step: number,
    cause: unknown,
    readonly oldObjects?: number,
    readonly readback?: QueryResult,
  ) {
    super(step, step === 1 ? "explicit original-package removal" : "cleanup readback", cause);
    this.name = "PackageRenameCleanupError";
  }
}

export async function executePackageCleanup(
  plan: PackageRenamePlan,
  callersMigrated: boolean,
  saveRecovery: (text: string) => void,
  execute: (sql: string) => Promise<QueryResult> = (sql) => api.executeQuery(plan.context.connectionId, plan.context.database, sql, plan.context.schema),
): Promise<{ migrationComplete: true; readback: QueryResult }> {
  if (!callersMigrated || !plan.cleanup || plan.statements.length !== 2 || plan.stages.length !== 2) throw new Error("Explicit caller-migration confirmation and the complete cleanup plan are required.");
  const states = ["not executed", "not executed"];
  const save = (error?: string, readback?: QueryResult) => saveRecovery(packageRenameRecoveryText(plan, 0, undefined, error, readback, states));
  save();
  let removalError: unknown;
  let readbackError: unknown;
  let readback: QueryResult | undefined;
  states[0] = "attempted; read back database state";
  save();
  try {
    assertQuerySucceeded(await execute(plan.statements[0]!));
    states[0] = "response received; readback pending";
  } catch (error) {
    removalError = error;
    states[0] = "error returned; outcome requires readback";
  }
  states[1] = "attempted";
  save(removalError instanceof Error ? removalError.message : removalError ? String(removalError) : undefined);
  try {
    readback = assertQuerySucceeded(await execute(plan.statements[1]!));
    states[1] = "response received";
  } catch (error) {
    readbackError = error;
    states[1] = "readback failed; object state unknown";
  }
  const count = (index: number) => {
    const value = readback?.rows.length === 1 ? readback.rows[0]?.[index] : undefined;
    if (value == null || (typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  };
  const oldObjects = count(0);
  const expected = plan.body !== undefined ? 2 : 1;
  const confirmed = oldObjects === 0 && count(1) === expected && count(2) === expected && count(3) === 0;
  if (removalError || readbackError || !confirmed) {
    const detail = [removalError, readbackError, ...(!confirmed ? ["Readback did not confirm the original absent and replacement pair VALID."] : [])]
      .filter(Boolean)
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    save(detail, readback);
    throw new PackageRenameCleanupError(removalError ? 1 : 2, new Error(detail), oldObjects, readback);
  }
  save(undefined, readback);
  return { migrationComplete: true, readback: readback! };
}
