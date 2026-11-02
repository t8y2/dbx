import { beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeOracleTypeManagement, prepareOracleTypeManagement, restoreOracleTypeManagementDraft, type TypeManagementTarget } from "@/lib/table/oracleTypeManagement";
import type { OracleTypeEvolutionManifest, OracleTypeManagementObject, OracleTypeManagementSnapshot } from "@/types/database";

vi.mock("@/lib/backend/api", () => ({ getOracleTypeManagementSnapshot: vi.fn(), buildOracleTypeManagementSql: vi.fn(), prepareOracleTypeEvolution: vi.fn(), executeConditionalUpdate: vi.fn(), cancelConditionalUpdate: vi.fn() }));
const target: TypeManagementTarget = { connectionId: "native-evolution", database: "db", owner: "APP", name: "ROOT", databaseType: "oracle" };
const before = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER(8,0), MEMBER FUNCTION F RETURN NUMBER);';
const after = 'CREATE OR REPLACE TYPE "APP"."ROOT" AS OBJECT (ID NUMBER(10,0), LABEL VARCHAR2(40 BYTE), MEMBER FUNCTION F RETURN NUMBER);';
const body = 'CREATE OR REPLACE TYPE BODY "APP"."ROOT" AS MEMBER FUNCTION F RETURN NUMBER IS BEGIN RETURN SELF.ID; END; END;';
const dependent = 'CREATE OR REPLACE TYPE "APP"."COLL" AS TABLE OF "APP"."ROOT";';
const statements = ['ALTER TYPE "APP"."ROOT" MODIFY ATTRIBUTE ("ID" NUMBER(10,0)) CASCADE INCLUDING TABLE DATA;', 'ALTER TYPE "APP"."ROOT" ADD ATTRIBUTE ("LABEL" VARCHAR2(40 BYTE)) CASCADE INCLUDING TABLE DATA;'];
const available = { state: "available" as const };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let phase: number;
let source: string;
let metadata: string;
let failAfter: boolean;
let writes: string[];
let pairedBody: string | undefined;
let bodyValid: boolean;
let dependentType: boolean;

function snapshot(): OracleTypeManagementSnapshot {
  const object = (name: string, objectType: string, text: string | null, objectId: string): OracleTypeManagementObject => ({
    owner: "APP",
    name,
    objectType,
    exists: true,
    objectId,
    status: "VALID",
    statusRead: available,
    source: text,
    sourceFingerprint: text,
    sourceRead: text ? available : { state: "unsupported" },
    errors: [],
    errorsRead: available,
    directPrivileges: [],
    privilegesRead: objectType === "TYPE" ? available : { state: "unsupported" },
  });
  const value: OracleTypeManagementSnapshot = {
    target,
    visibilityScope: "current-user-visible-dictionaries",
    actingUser: "APP",
    actingUserRead: available,
    detailsRead: available,
    typeSource: source,
    typeSourceRead: available,
    bodySourceRead: available,
    objects: [object("ROOT", "TYPE", source, "1001"), object("DATA", "TABLE", null, "1002")],
    dependencies: [{ owner: "APP", name: "DATA", objectType: "TABLE", referencedOwner: "APP", referencedName: "ROOT", referencedType: "TYPE" }],
    dependenciesRead: available,
    persistentReferences: [{ owner: "APP", tableName: "DATA", columnName: "VALUE", dataTypeOwner: "APP", dataType: "ROOT", tableReadOnly: false }],
    persistentReferencesRead: available,
    directPrivileges: [],
    privilegesRead: available,
  };
  if (pairedBody) {
    value.objects.push({ ...object("ROOT", "TYPE BODY", pairedBody, "1004"), status: bodyValid ? "VALID" : "INVALID" });
    value.dependencies.push({ owner: "APP", name: "ROOT", objectType: "TYPE BODY", referencedOwner: "APP", referencedName: "ROOT", referencedType: "TYPE" });
  }
  if (dependentType) {
    value.objects.push({ ...object("COLL", "TYPE", dependent, "1003"), directPrivileges: [{ grantor: "OTHER_GRANTOR", grantee: "READER", privilege: "EXECUTE", grantable: false, hierarchy: false }] });
    value.dependencies.push({ owner: "APP", name: "COLL", objectType: "TYPE", referencedOwner: "APP", referencedName: "ROOT", referencedType: "TYPE" });
  }
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelConditionalUpdate).mockResolvedValue({ requested: false, terminal: true, databaseTerminal: true });
  phase = 0;
  source = before;
  metadata = "exact identity, grants, restrictions and native row-count guards";
  failAfter = false;
  writes = [];
  pairedBody = undefined;
  bodyValid = true;
  dependentType = false;
  vi.mocked(api.getOracleTypeManagementSnapshot).mockImplementation(async () => copy(snapshot()));
  vi.mocked(api.prepareOracleTypeEvolution).mockImplementation(async (input): Promise<OracleTypeEvolutionManifest> => {
    if (input.manifest && input.manifest.metadata !== metadata) throw new Error("Native evolution metadata changed");
    return { target, sourceBefore: before, sourceAfter: after, statements, metadata, phase };
  });
  vi.mocked(api.buildOracleTypeManagementSql).mockImplementation(async (input) => ({ statements: [input.operation === "compile_spec" ? `ALTER TYPE "${input.owner}"."${input.name}" COMPILE SPECIFICATION;` : (input.source ?? "compile specification")], sourceFingerprint: input.source }));
  vi.mocked(api.executeConditionalUpdate).mockImplementation(async (_id, _database, sql) => {
    writes.push(sql);
    if (sql.startsWith("CREATE OR REPLACE TYPE BODY")) {
      pairedBody = sql;
      bodyValid = !sql.includes("NO_SUCH_IDENTIFIER");
      return { rows: [], messages: [] } as never;
    }
    if (sql === 'ALTER TYPE "APP"."COLL" COMPILE SPECIFICATION;') return { rows: [], messages: [] } as never;
    if (sql !== statements[phase]) throw new Error("Unexpected or replayed native evolution SQL");
    phase++;
    source = phase === 1 ? 'CREATE TYPE "APP"."ROOT" AS OBJECT(ID NUMBER(10,0), MEMBER FUNCTION F RETURN NUMBER);' : 'CREATE TYPE "APP"."ROOT" AS OBJECT(ID NUMBER(10,0),LABEL VARCHAR2(40 BYTE), MEMBER FUNCTION F RETURN NUMBER);';
    bodyValid = false;
    if (failAfter) throw new Error("Lost native DDL response");
    return { rows: [], messages: [] } as never;
  });
});

it("uses Oracle native in-place evolution without demanding manual baselines or dropping the stored UDT table", async () => {
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: after }]);
  expect(plan.issues).toEqual([]);
  expect(plan.dataMappings).toEqual([]);
  expect(plan.steps.map((step) => step.sql)).toEqual(statements);
  expect(api.executeConditionalUpdate).not.toHaveBeenCalled();
  await executeOracleTypeManagement(plan, { persist: async () => {} });
  expect(plan.state).toBe("complete");
  expect(writes).toEqual(statements);
  expect(plan.lastSnapshot.objects.find((object) => object.objectType === "TABLE")?.objectId).toBe("1002");
});

it("reconciles a lost native response by metadata and resumes only the remaining phase after durable reopening", async () => {
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: after }]);
  failAfter = true;
  await expect(executeOracleTypeManagement(plan, { persist: async () => {}, shouldStop: () => phase >= 1 })).rejects.toThrow("Stopped");
  expect(plan.steps[0].state).toBe("confirmed");
  expect(plan.steps[1].state).toBe("not-sent");
  const reopened = restoreOracleTypeManagementDraft(copy(plan))!;
  const verified = await prepareOracleTypeManagement(target, "save-spec", reopened.drafts, reopened);
  failAfter = false;
  await executeOracleTypeManagement(verified, { persist: async () => {} });
  expect(verified.state).toBe("complete");
  expect(writes).toEqual(statements);
});

it("detects native guard changes before dispatch and never falls back to destructive source replacement", async () => {
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: after }]);
  metadata = "changed table identity or implicit index restriction";
  await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("metadata changed");
  expect(writes).toEqual([]);
  expect(plan.executable).toBe(false);
  expect(plan.requiresReverify).toBe(true);
});

it("keeps the manual repair route available when an unstarted native preview becomes inapplicable", async () => {
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: after }]);
  vi.mocked(api.prepareOracleTypeEvolution).mockRejectedValue(new Error("Unknown attribute index or storage restriction"));
  const next = await prepareOracleTypeManagement(target, "save-spec", plan.drafts, plan);
  expect(next.nativeEvolution).toBeUndefined();
  expect(next.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["native-evolution", "persistent-mapping"]));
  expect(next.executable).toBe(false);
  expect(next.drafts.find((draft) => draft.name === "ROOT")?.source).toBe(after);
  expect(writes).toEqual([]);
});

it("repairs a failed BODY after native evolution without replaying either applied structural phase", async () => {
  pairedBody = body;
  const bad = body.replace("SELF.ID", "NO_SUCH_IDENTIFIER");
  const plan = await prepareOracleTypeManagement(target, "save-spec", [
    { owner: "APP", name: "ROOT", objectType: "TYPE", source: after },
    { owner: "APP", name: "ROOT", objectType: "TYPE BODY", source: bad },
  ]);
  await expect(executeOracleTypeManagement(plan, { persist: async () => {} })).rejects.toThrow("INVALID");
  expect(plan.steps.filter((step) => step.kind === "evolve").every((step) => step.state === "confirmed")).toBe(true);
  const previous = restoreOracleTypeManagementDraft(copy(plan))!;
  const drafts = previous.drafts.map((draft) => ({ ...draft, source: draft.objectType === "TYPE BODY" ? body : draft.source }));
  const next = await prepareOracleTypeManagement(target, "save-spec", drafts, previous);
  expect(next.issues).toEqual([]);
  await executeOracleTypeManagement(next, { persist: async () => {} });
  expect(next.state).toBe("complete");
  expect(writes).toEqual([...statements, bad, body]);
  expect(next.history.some((step) => step.sql === bad && step.state === "failed")).toBe(true);
});

it("compiles unchanged dependent TYPE specifications and preserves grants without dropping or recreating them", async () => {
  dependentType = true;
  const plan = await prepareOracleTypeManagement(target, "save-spec", [{ owner: "APP", name: "ROOT", objectType: "TYPE", source: after }]);
  expect(plan.issues).toEqual([]);
  expect(plan.steps.map((step) => step.kind)).toEqual(["evolve", "evolve", "compile"]);
  await executeOracleTypeManagement(plan, { persist: async () => {} });
  expect(writes).toEqual([...statements, 'ALTER TYPE "APP"."COLL" COMPILE SPECIFICATION;']);
  expect(plan.lastSnapshot.objects.find((object) => object.name === "COLL")?.objectId).toBe("1003");
  expect(plan.lastSnapshot.objects.find((object) => object.name === "COLL")?.directPrivileges[0].grantor).toBe("OTHER_GRANTOR");
});
