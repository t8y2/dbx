import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { DatabaseType, QueryResult } from "@/types/database";
import { oraclePackageCatalogSource, rewriteOraclePackageSource } from "@/lib/table/oraclePackageSource";

export interface OraclePackageSaveAsTarget {
  connectionId: string;
  database: string;
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle">;
  schema: string;
  oldName: string;
  newName: string;
}

interface PackageSnapshot {
  name: string;
  specId: string;
  specStatus: string;
  specSource: string;
  bodyId: string | null;
  bodyStatus: string | null;
  bodySource: string | null;
  signature: string;
  grants: string;
}

export interface OraclePackageSaveAsPlan {
  target: OraclePackageSaveAsTarget;
  canonicalNewName: string;
  snapshot: PackageSnapshot | null;
  specDraft: string;
  bodyDraft: string | null;
  specSource: string;
  bodySource: string | null;
  statements: string[];
  issues: Array<{ code: string; message: string; objectName?: string; repairable: boolean }>;
  metadataComplete: boolean;
  executable: boolean;
}

export class OraclePackageSaveAsFailure extends Error {
  constructor(
    public readonly plan: OraclePackageSaveAsPlan,
    public readonly completed: string[],
    public readonly uncertain: string,
    cause: unknown,
    public readonly dispatched: boolean,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Package Save As stopped. Created and verified: ${completed.join(", ") || "none"}. Check ${uncertain} before retrying. ${message}`);
  }
}

const metadataLimit = 5000;
const sourceLimit = 1_000_000;
const namespaceTypes = ["TABLE", "VIEW", "SEQUENCE", "SYNONYM", "PROCEDURE", "FUNCTION", "PACKAGE", "MATERIALIZED VIEW", "TYPE", "OPERATOR"];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const qualified = (schema: string, name: string) => `${identifier(schema)}.${identifier(name)}`;

async function query(target: OraclePackageSaveAsTarget, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { maxRows: metadataLimit + 1 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Package metadata query failed.");
  if (result.truncated || result.has_more || result.rows.length > metadataLimit || result.large_value_cells?.length) throw new Error("Package metadata is incomplete; refresh the Save As preview.");
  return result;
}

async function checkOwner(target: OraclePackageSaveAsTarget) {
  const result = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
  if (result.rows.length !== 1 || result.rows[0][0] !== target.schema || result.rows[0][1] !== target.schema) throw new Error("Package Save As requires the package owner and matching current schema.");
}

async function objectStates(target: OraclePackageSaveAsTarget, name: string, types: string[] = namespaceTypes) {
  return (await query(target, `SELECT OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS FROM USER_OBJECTS WHERE OBJECT_NAME=${literal(name)} AND OBJECT_TYPE IN (${types.map(literal).join(",")}) ORDER BY OBJECT_TYPE`)).rows;
}

async function readSource(target: OraclePackageSaveAsTarget, name: string, type: "PACKAGE" | "PACKAGE BODY"): Promise<string> {
  const result = await query(target, `SELECT LINE, TEXT FROM ALL_SOURCE WHERE OWNER=${literal(target.schema)} AND NAME=${literal(name)} AND TYPE=${literal(type)} ORDER BY LINE`);
  if (result.rows.length > metadataLimit) throw new Error(`Complete ${type} source is unavailable for ${name}.`);
  if (!result.rows.length) return "";
  let expectedLine = 1;
  const lines: string[] = [];
  for (const [line, text] of result.rows) {
    if (Number(line) !== expectedLine++ || typeof text !== "string") throw new Error(`Complete ${type} source is unavailable for ${name}.`);
    lines.push(text.replace(/\r?\n$/, ""));
  }
  const source = lines.join("\n");
  if (!source.trim() || source.length > sourceLimit) throw new Error(`Complete ${type} source is unavailable for ${name}.`);
  return source;
}

function normalizedRows(rows: unknown[][], selfPackage: { owner: string; name: string }, packageTypeColumn?: number) {
  return rows.map((row) =>
    row.map((value, index) => {
      if (packageTypeColumn === index && row[10] === selfPackage.owner && value === selfPackage.name) return "<SELF_PACKAGE>";
      return value === null ? null : String(value);
    }),
  );
}

async function readSignature(target: OraclePackageSaveAsTarget, name: string) {
  const members = (await query(target, `SELECT PROCEDURE_NAME, OVERLOAD FROM ALL_PROCEDURES WHERE OWNER=${literal(target.schema)} AND OBJECT_NAME=${literal(name)} AND OBJECT_TYPE='PACKAGE' ORDER BY PROCEDURE_NAME, OVERLOAD`)).rows;
  const argumentsRows = (
    await query(
      target,
      `SELECT OBJECT_NAME, OVERLOAD, SEQUENCE, POSITION, ARGUMENT_NAME, IN_OUT, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, TYPE_OWNER, TYPE_NAME, TYPE_SUBNAME, DEFAULTED FROM ALL_ARGUMENTS WHERE OWNER=${literal(target.schema)} AND PACKAGE_NAME=${literal(name)} ORDER BY OBJECT_NAME, OVERLOAD, SEQUENCE`,
    )
  ).rows;
  return JSON.stringify([normalizedRows(members, { owner: target.schema, name }), normalizedRows(argumentsRows, { owner: target.schema, name }, 11)]);
}

async function readGrants(target: OraclePackageSaveAsTarget, name: string) {
  const rows = (await query(target, `SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA=${literal(target.schema)} AND TABLE_NAME=${literal(name)} ORDER BY GRANTOR, GRANTEE, PRIVILEGE`)).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function readErrors(target: OraclePackageSaveAsTarget, name: string, type: "PACKAGE" | "PACKAGE BODY") {
  const rows = (await query(target, `SELECT ATTRIBUTE, LINE, POSITION, TEXT FROM USER_ERRORS WHERE NAME=${literal(name)} AND TYPE=${literal(type)} ORDER BY SEQUENCE`)).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function readSnapshot(target: OraclePackageSaveAsTarget, name: string): Promise<PackageSnapshot> {
  const states = await objectStates(target, name, ["PACKAGE", "PACKAGE BODY"]);
  const spec = states.filter((row) => row[0] === name && row[1] === "PACKAGE");
  const body = states.filter((row) => row[0] === name && row[1] === "PACKAGE BODY");
  if (spec.length !== 1 || (typeof spec[0]![2] !== "number" && typeof spec[0]![2] !== "string")) throw new Error(`Package ${name} specification is missing or has an ambiguous identity.`);
  if (body.length > 1 || (body.length === 1 && typeof body[0]![2] !== "number" && typeof body[0]![2] !== "string")) throw new Error(`Package ${name} body has an ambiguous identity.`);
  const specSource = await readSource(target, name, "PACKAGE");
  const bodySourceRead = await readSource(target, name, "PACKAGE BODY");
  if (!specSource || Boolean(body.length) !== Boolean(bodySourceRead)) throw new Error(`Package ${name} body presence differs between the object dictionary and source catalog.`);
  return {
    name,
    specId: String(spec[0]![2]),
    specStatus: String(spec[0]![3]),
    specSource,
    bodyId: body.length ? String(body[0]![2]) : null,
    bodyStatus: body.length ? String(body[0]![3]) : null,
    bodySource: body.length ? bodySourceRead : null,
    signature: await readSignature(target, name),
    grants: await readGrants(target, name),
  };
}

function grantStatements(target: OraclePackageSaveAsTarget, grants: string) {
  const rows = JSON.parse(grants) as Array<Array<string | null>>;
  return rows.map(([grantor, grantee, privilege, grantable]) => {
    if (grantor !== target.schema || privilege !== "EXECUTE" || !grantee) throw new Error(`Cannot safely copy package grant ${String(privilege)} from ${String(grantor)}.`);
    return `GRANT EXECUTE ON ${qualified(target.schema, target.newName)} TO ${grantee === "PUBLIC" ? "PUBLIC" : identifier(grantee)}${grantable === "YES" ? " WITH GRANT OPTION" : ""};`;
  });
}

function planIdentity(plan: OraclePackageSaveAsPlan) {
  return JSON.stringify([plan.target, plan.canonicalNewName, plan.snapshot, plan.specDraft, plan.bodyDraft, plan.specSource, plan.bodySource, plan.statements, plan.issues, plan.metadataComplete]);
}

function packageDrafts(plan: OraclePackageSaveAsPlan) {
  return { spec: plan.specDraft, ...(plan.bodyDraft === null ? {} : { body: plan.bodyDraft }) };
}

export async function prepareOraclePackageSaveAs(target: OraclePackageSaveAsTarget, drafts: { spec?: string; body?: string } = {}): Promise<OraclePackageSaveAsPlan> {
  target = { ...target };
  const plan: OraclePackageSaveAsPlan = {
    target,
    canonicalNewName: target.newName,
    snapshot: null,
    specDraft: "",
    bodyDraft: null,
    specSource: "",
    bodySource: null,
    statements: [],
    issues: [],
    metadataComplete: true,
    executable: false,
  };
  try {
    plan.canonicalNewName = await api.parseOracleObjectName(target.newName);
    if (plan.canonicalNewName === target.oldName) plan.issues.push({ code: "invalid_name", message: "The new package name matches the existing name.", repairable: false });
    await checkOwner(target);
    const conflicts = await objectStates(target, plan.canonicalNewName);
    if (conflicts.length) plan.issues.push({ code: "target_conflict", message: `An object named ${plan.canonicalNewName} already exists.`, repairable: false });
  } catch (error) {
    plan.metadataComplete = false;
    plan.issues.push({ code: "metadata_incomplete", message: error instanceof Error ? error.message : String(error), repairable: false });
  }

  try {
    plan.snapshot = await readSnapshot(target, target.oldName);
    plan.specDraft = drafts.spec ?? plan.snapshot.specSource;
    plan.bodyDraft = plan.snapshot.bodySource === null ? null : (drafts.body ?? plan.snapshot.bodySource);
    if (plan.snapshot.specStatus !== "VALID" || (plan.snapshot.bodyStatus && plan.snapshot.bodyStatus !== "VALID")) plan.issues.push({ code: "invalid_source", message: `The existing package is ${plan.snapshot.specStatus}/${plan.snapshot.bodyStatus || "no body"}.`, repairable: false });
  } catch (error) {
    plan.metadataComplete = false;
    plan.issues.push({ code: "source_read_failed", message: error instanceof Error ? error.message : String(error), repairable: false });
  }

  if (plan.snapshot) {
    if (plan.snapshot.bodySource === null && drafts.body !== undefined) {
      plan.issues.push({ code: "invalid_draft", message: "A package without a body cannot be given a body draft.", objectName: "PACKAGE BODY", repairable: false });
    }
    try {
      plan.specSource = rewriteOraclePackageSource(plan.specDraft, { owner: target.schema, oldName: target.oldName, newName: plan.canonicalNewName, body: false });
      const statements = await api.buildExecutableObjectSourceStatements({
        databaseType: target.databaseType,
        objectType: "PACKAGE",
        schema: target.schema,
        name: plan.canonicalNewName,
        source: plan.specSource,
      });
      if (statements.length !== 1) throw new Error("Package source must produce exactly one object definition.");
    } catch (error) {
      plan.issues.push({ code: "source_rewrite_failed", message: error instanceof Error ? error.message : String(error), objectName: "PACKAGE", repairable: true });
    }
    if (plan.bodyDraft !== null) {
      try {
        plan.bodySource = rewriteOraclePackageSource(plan.bodyDraft, { owner: target.schema, oldName: target.oldName, newName: plan.canonicalNewName, body: true });
        const statements = await api.buildExecutableObjectSourceStatements({
          databaseType: target.databaseType,
          objectType: "PACKAGE_BODY",
          schema: target.schema,
          name: plan.canonicalNewName,
          source: plan.bodySource,
        });
        if (statements.length !== 1) throw new Error("Package body source must produce exactly one object definition.");
      } catch (error) {
        plan.issues.push({ code: "source_rewrite_failed", message: error instanceof Error ? error.message : String(error), objectName: "PACKAGE BODY", repairable: true });
      }
    }
    if (plan.metadataComplete && plan.issues.length === 0 && plan.specSource && (plan.bodyDraft === null || plan.bodySource)) {
      try {
        const nextTarget = { ...target, newName: plan.canonicalNewName };
        plan.statements = [plan.specSource, ...(plan.bodySource ? [plan.bodySource] : []), ...grantStatements(nextTarget, plan.snapshot.grants)];
        plan.executable = true;
      } catch (error) {
        plan.issues.push({ code: "grant_build_failed", message: error instanceof Error ? error.message : String(error), objectName: "PACKAGE", repairable: false });
      }
    }
  }
  return plan;
}

async function verifyCreatedPackage(target: OraclePackageSaveAsTarget, expected: { specSource: string; bodySource: string | null; signature: string; grants: string }, requireBody: boolean): Promise<PackageSnapshot> {
  const canonicalName = await api.parseOracleObjectName(target.newName);
  const snapshot = await readSnapshot(target, canonicalName);
  if (oraclePackageCatalogSource(snapshot.specSource) !== expected.specSource || snapshot.signature !== expected.signature || snapshot.grants !== expected.grants) throw new Error(`Created package ${target.newName} does not match the validated specification, members, or grants.`);
  if (snapshot.specStatus !== "VALID" || (snapshot.bodyStatus && snapshot.bodyStatus !== "VALID")) throw new Error(`Created package ${target.newName} is invalid.`);
  if ((requireBody && snapshot.bodySource !== null && expected.bodySource !== null && oraclePackageCatalogSource(snapshot.bodySource) !== expected.bodySource) || (!requireBody && snapshot.bodySource !== null)) throw new Error(`Created package ${target.newName} body does not match the preview.`);
  if (JSON.parse(await readErrors(target, canonicalName, "PACKAGE")).length || (snapshot.bodySource && JSON.parse(await readErrors(target, canonicalName, "PACKAGE BODY")).length)) throw new Error(`Created package ${target.newName} has compile errors.`);
  return snapshot;
}

export async function executeOraclePackageSaveAs(plan: OraclePackageSaveAsPlan, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error("The package Save As target changed. Refresh the preview.");
  if (!plan.executable || !plan.snapshot) throw new Error("Resolve the package Save As preview issues before execution.");
  const current = await prepareOraclePackageSaveAs(plan.target, packageDrafts(plan));
  if (!current.executable || planIdentity(current) !== planIdentity(plan)) throw new Error("The package or its members changed. Refresh the Save As preview.");

  const lock = freezeSourceIdentities(["PACKAGE", "PACKAGE_BODY"].map((objectType) => ({ connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema, objectType, name: plan.target.oldName })));
  const completed: string[] = [];
  let dispatched = false;
  let active = `PACKAGE ${plan.canonicalNewName}`;
  try {
    if (!isCurrent()) throw new Error("The Save As dialog changed before execution.");
    const before = await readSnapshot(plan.target, plan.target.oldName);
    if (!isCurrent()) throw new Error("The Save As dialog changed before package creation.");
    if (JSON.stringify(before) !== JSON.stringify(plan.snapshot)) throw new Error("The original package changed before execution.");
    if ((await objectStates(plan.target, plan.canonicalNewName)).length) throw new Error(`Package target ${plan.canonicalNewName} already exists.`);

    if (!isCurrent()) throw new Error("The Save As dialog changed before package creation.");
    active = `PACKAGE ${plan.canonicalNewName}`;
    dispatched = true;
    await query(plan.target, plan.specSource);
    const specState = (await objectStates(plan.target, plan.canonicalNewName, ["PACKAGE"])).filter((row) => row[0] === plan.canonicalNewName && row[1] === "PACKAGE");
    const specSource = await readSource(plan.target, plan.canonicalNewName, "PACKAGE");
    if (specState.length !== 1 || oraclePackageCatalogSource(specSource) !== oraclePackageCatalogSource(plan.specSource)) throw new Error(`Created package ${plan.canonicalNewName} specification did not match the preview.`);
    const createdSpecId = String(specState[0]![2]);
    let createdBodyId: string | null = null;
    completed.push(`PACKAGE ${plan.canonicalNewName}`);

    if (plan.bodySource) {
      if (!isCurrent()) throw new Error("The Save As dialog changed before package body creation.");
      const currentSpec = (await objectStates(plan.target, plan.canonicalNewName, ["PACKAGE"])).filter((row) => row[0] === plan.canonicalNewName && row[1] === "PACKAGE");
      const currentSource = currentSpec.length === 1 ? await readSource(plan.target, plan.canonicalNewName, "PACKAGE") : "";
      if (!isCurrent()) throw new Error("The Save As dialog changed before package body creation.");
      if (currentSpec.length !== 1 || String(currentSpec[0]![2]) !== createdSpecId || oraclePackageCatalogSource(currentSource) !== oraclePackageCatalogSource(plan.specSource)) throw new Error("The new package specification identity or definition changed before body creation.");
      active = `PACKAGE BODY ${plan.canonicalNewName}`;
      await query(plan.target, plan.bodySource);
      const bodyState = (await objectStates(plan.target, plan.canonicalNewName, ["PACKAGE BODY"])).filter((row) => row[0] === plan.canonicalNewName && row[1] === "PACKAGE BODY");
      const bodySource = await readSource(plan.target, plan.canonicalNewName, "PACKAGE BODY");
      if (bodyState.length !== 1 || oraclePackageCatalogSource(bodySource) !== oraclePackageCatalogSource(plan.bodySource)) throw new Error(`Created package body ${plan.canonicalNewName} did not match the preview.`);
      createdBodyId = String(bodyState[0]![2]);
      completed.push(`PACKAGE BODY ${plan.canonicalNewName}`);
    }

    for (const grantSql of grantStatements({ ...plan.target, newName: plan.canonicalNewName }, plan.snapshot.grants)) {
      if (!isCurrent()) throw new Error("The Save As dialog changed before grant creation.");
      active = `grants for ${plan.canonicalNewName}`;
      await query(plan.target, grantSql);
      completed.push(active);
    }

    if (!isCurrent()) throw new Error("The Save As dialog changed before final readback.");
    active = `PACKAGE ${plan.canonicalNewName} final readback`;
    const expectedSignature = JSON.stringify(JSON.parse(plan.snapshot.signature));
    const verified = await verifyCreatedPackage(plan.target, { specSource: oraclePackageCatalogSource(plan.specSource), bodySource: plan.bodySource === null ? null : oraclePackageCatalogSource(plan.bodySource), signature: expectedSignature, grants: plan.snapshot.grants }, plan.bodySource !== null);
    if (verified.specId !== createdSpecId || verified.bodyId !== createdBodyId) throw new Error("The new package identity changed before final verification.");
    const oldFinal = await readSnapshot(plan.target, plan.target.oldName);
    if (JSON.stringify(oldFinal) !== JSON.stringify(plan.snapshot)) throw new Error("The original package changed while the copy was being created.");
  } catch (error) {
    throw new OraclePackageSaveAsFailure(plan, completed, active, error, dispatched);
  } finally {
    // Save As is a temporary read/write exclusion, never a migration freeze.
    lock.cancel();
    if (dispatched) {
      const scope = { connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema };
      await Promise.allSettled([Promise.resolve().then(() => invalidateObjectBrowserRowsCache(scope)), ...[plan.target.oldName, plan.canonicalNewName].map((name) => Promise.resolve().then(() => invalidateObjectDdlCache({ ...scope, tableName: name })))]);
    }
  }
}
