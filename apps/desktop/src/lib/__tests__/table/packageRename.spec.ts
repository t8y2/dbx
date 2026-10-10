import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";

const backend = vi.hoisted(() => ({ executeQuery: vi.fn(), getObjectSource: vi.fn(), buildRoutineRenameObjectSourceStatements: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);
import { executePackageCleanup, executePackageRename, PackageRenameCleanupError, PackageRenameStepError, preparePackageRename, supportsPackageRename } from "@/lib/table/packageRename";

const context = { connectionId: "connection", database: "db", databaseType: "oceanbase-oracle" as const, schema: "Mixed.Owner", name: "Old.Pkg", newName: "New.Pkg" };
const result = (rows: unknown[][] = []): QueryResult => ({ columns: [], rows: rows as QueryResult["rows"], affected_rows: 0, execution_time_ms: 0 });
const specification = 'CREATE PACKAGE "Mixed.Owner"."Old.Pkg" AS PROCEDURE RUN; END;';
const body = 'CREATE PACKAGE BODY "Mixed.Owner"."Old.Pkg" AS PROCEDURE RUN IS BEGIN NULL; END; END;';

beforeEach(() => {
  vi.resetAllMocks();
  backend.executeQuery.mockResolvedValue(result([["PACKAGE"], ["PACKAGE BODY"]]));
  backend.getObjectSource.mockImplementation(async (_connection, _database, schema, name, objectType) => ({ schema, name, object_type: objectType, source: objectType === "PACKAGE" ? specification : body }));
  backend.buildRoutineRenameObjectSourceStatements.mockResolvedValue(["preflight", "spec", "body", "validate", "grants", "dependencies"]);
});

describe("package migration", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("prepares the complete %s specification/body pair with exact identities", async (databaseType) => {
    const plan = await preparePackageRename({ ...context, databaseType });
    expect(plan.specification).toBe(specification);
    expect(plan.body).toBe(body);
    expect(backend.getObjectSource.mock.calls.map((call) => call[4])).toEqual(["PACKAGE", "PACKAGE_BODY"]);
    expect(backend.buildRoutineRenameObjectSourceStatements).toHaveBeenCalledWith(expect.objectContaining({ source: specification, packageBodySource: body, objectType: "PACKAGE", schema: "Mixed.Owner" }));
    expect(backend.executeQuery.mock.calls.every((call) => String(call[2]).startsWith("SELECT"))).toBe(true);
  });

  it("does not invent a body for a specification-only package", async () => {
    backend.executeQuery.mockResolvedValue(result([["PACKAGE"]]));
    backend.buildRoutineRenameObjectSourceStatements.mockResolvedValue(["preflight", "spec", "validate", "grants", "dependencies"]);
    const plan = await preparePackageRename(context);
    expect(plan.body).toBeUndefined();
    expect(backend.getObjectSource).toHaveBeenCalledTimes(1);
    expect(plan.stages).not.toContain("create body");
  });

  it("does not mistake inaccessible metadata or mismatched source for an absent body", async () => {
    backend.executeQuery.mockRejectedValueOnce(new Error("dictionary permission denied"));
    await expect(preparePackageRename(context)).rejects.toThrow("dictionary permission denied");
    expect(backend.getObjectSource).not.toHaveBeenCalled();
    backend.getObjectSource.mockResolvedValue({ name: "Other", object_type: "PACKAGE", schema: context.schema, source: specification });
    await expect(preparePackageRename(context)).rejects.toThrow("identity");
    expect(backend.buildRoutineRenameObjectSourceStatements).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5])("stops after stage %s fails and retains recovery source plus uncertain attempted SQL", async (failed) => {
    const plan = await preparePackageRename(context);
    const execute = vi.fn(async () => result());
    execute.mockImplementation(async () => {
      if (execute.mock.calls.length === failed + 1) throw new Error("lost response");
      return result();
    });
    const save = vi.fn();
    await expect(executePackageRename(plan, save, execute)).rejects.toMatchObject({ step: failed + 1 });
    expect(execute).toHaveBeenCalledTimes(failed + 1);
    expect(save.mock.calls[0]![0]).toContain(specification);
    const recovery = save.mock.lastCall![0];
    expect(recovery).toContain(body);
    expect(recovery).toContain("attempted; read back database state");
    expect(recovery).toContain("lost response");
  });

  it("stops on a successful RPC envelope containing an execution error", async () => {
    const plan = await preparePackageRename(context);
    const execute = vi.fn().mockResolvedValue({ ...result([["compile failed"]]), execution_error: true });
    await expect(executePackageRename(plan, vi.fn(), execute)).rejects.toBeInstanceOf(PackageRenameStepError);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps migration incomplete after successful creation and retains dependency results", async () => {
    const plan = await preparePackageRename(context);
    const dependencies = result([
      ["STATIC_DEPENDENCIES", 2],
      ["SYNONYMS", 1],
    ]);
    const execute = vi.fn().mockResolvedValue(dependencies);
    const save = vi.fn();
    expect(await executePackageRename(plan, save, execute)).toEqual({ migrationComplete: false, dependencies });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(plan.statements);
    expect(save.mock.lastCall![0]).toContain('[["STATIC_DEPENDENCIES",2],["SYNONYMS",1]]');
    expect(supportsPackageRename("oracle", "PACKAGE_BODY")).toBe(true);
    expect(supportsPackageRename("dameng", "PACKAGE")).toBe(false);
  });
});

describe("explicit original-package cleanup", () => {
  async function cleanupPlan() {
    backend.buildRoutineRenameObjectSourceStatements.mockResolvedValue(["guarded cleanup", "readback"]);
    return preparePackageRename(context, { cleanup: true, callersMigrated: true });
  }

  it("requires caller-migration acknowledgement before metadata preparation or execution", async () => {
    await expect(preparePackageRename(context, { cleanup: true })).rejects.toThrow("Confirm migration");
    expect(backend.executeQuery).not.toHaveBeenCalled();
    const plan = await cleanupPlan();
    const execute = vi.fn();
    await expect(executePackageCleanup(plan, false, vi.fn(), execute)).rejects.toThrow("confirmation");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads both source pairs and requests the distinct cleanup backend contract", async () => {
    const plan = await cleanupPlan();
    expect(plan.cleanup).toBe(true);
    expect(backend.getObjectSource.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      [context.name, "PACKAGE"],
      [context.name, "PACKAGE_BODY"],
      [context.newName, "PACKAGE"],
      [context.newName, "PACKAGE_BODY"],
    ]);
    expect(backend.buildRoutineRenameObjectSourceStatements).toHaveBeenCalledWith(expect.objectContaining({ packageCleanup: true, source: specification, packageBodySource: body }));
  });

  it("rejects a replacement that is missing the original package body", async () => {
    backend.executeQuery.mockResolvedValueOnce(result([["PACKAGE"], ["PACKAGE BODY"]])).mockResolvedValueOnce(result([["PACKAGE"]]));
    await expect(cleanupPlan()).rejects.toThrow("pair differs");
    expect(backend.buildRoutineRenameObjectSourceStatements).not.toHaveBeenCalled();
  });

  it("reports completion only after old-name absence and both new objects are read back VALID", async () => {
    const plan = await cleanupPlan();
    const readback = result([[0, 2, 2, 0]]);
    const execute = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(readback);
    const save = vi.fn();
    expect(await executePackageCleanup(plan, true, save, execute)).toEqual({ migrationComplete: true, readback });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(["guarded cleanup", "readback"]);
    const recovery = save.mock.lastCall![0];
    expect(recovery).toContain("REPLACEMENT BODY");
    expect(recovery).toContain("Cleanup readback: [[0,2,2,0]]");
    expect(recovery).not.toContain("original package was not dropped by this plan");
  });

  it.each([2, 0])("preserves a failed removal response and records actual old-object count %s without retrying DDL", async (oldObjects) => {
    const plan = await cleanupPlan();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("removal-response-error"))
      .mockResolvedValueOnce(result([[oldObjects, 2, 2, 0]]));
    const save = vi.fn();
    await expect(executePackageCleanup(plan, true, save, execute)).rejects.toMatchObject({ oldObjects, message: expect.stringContaining("removal-response-error") });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(["guarded cleanup", "readback"]);
    expect(save.mock.lastCall![0]).toContain("error returned; outcome requires readback");
    expect(save.mock.lastCall![0]).toContain("2. read back package identities: response received");
  });

  it("retains unknown outcome when cleanup or its readback loses a response", async () => {
    const plan = await cleanupPlan();
    const execute = vi.fn().mockRejectedValueOnce(new Error("network-drop")).mockRejectedValueOnce(new Error("readback-denied"));
    const save = vi.fn();
    await expect(executePackageCleanup(plan, true, save, execute)).rejects.toMatchObject({ oldObjects: undefined, message: expect.stringContaining("network-drop; readback-denied") });
    expect(save.mock.lastCall![0]).toContain("readback failed; object state unknown");
    expect(save.mock.lastCall![0]).toContain(specification);
    expect(save.mock.lastCall![0]).toContain(body);
  });

  it.each([[], [[null, 2, 2, 0]], [[0, 1, 2, 0]], [[0, 2, 2, 1]], [[2, 2, 2, 0]]].map((rows) => ({ rows })))("does not treat incomplete or invalid readback $rows as successful cleanup", async ({ rows }) => {
    const plan = await cleanupPlan();
    const execute = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result(rows));
    await expect(executePackageCleanup(plan, true, vi.fn(), execute)).rejects.toBeInstanceOf(PackageRenameCleanupError);
  });
});
