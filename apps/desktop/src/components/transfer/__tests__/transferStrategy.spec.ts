import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferOwnershipPreview, TransferRequest } from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { confirmTransferWithProductionSafety, createTransferSubmission, rebuildUnavailableReason, resolveTransferStrategy, supportsTransferUpsert, transferStrategyOptions, transferPreviewSql } from "../transferStrategy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    transferId: "transfer-1",
    sourceConnectionId: "source",
    sourceDatabase: "app",
    sourceSchema: "public",
    targetConnectionId: "target",
    targetDatabase: "warehouse",
    targetSchema: "reporting",
    tables: ["Orders"],
    objects: [{ objectType: "TABLE", names: ["Orders"] }],
    createTable: true,
    content: "structureAndData",
    mode: "append",
    targetTableNameCase: "lower",
    quoteTargetColumnNames: true,
    ownershipPolicy: "preserve",
    batchSize: 1000,
    dropTargetBeforeCreate: true,
    dropTargetConfirmed: false,
    ...overrides,
  };
}

function preview(overrides: Partial<TransferOwnershipPreview> = {}): TransferOwnershipPreview {
  return {
    missingOwners: [],
    targetOwner: "target_user",
    rebuild: {
      sql: 'ALTER TABLE "reporting"."orders" RENAME TO "orders__dbx_bak_123";\nCREATE TABLE "reporting"."orders" ("id" INTEGER);',
      tables: [{ sourceTable: "Orders", targetTable: '"reporting"."orders"', backupTable: '"reporting"."orders__dbx_bak_123"' }],
    },
    ...overrides,
  };
}

describe("transfer strategies", () => {
  it.each(["append", "overwrite", "upsert"] as const)("loads legacy %s plus rebuild as rebuild", (mode) => {
    expect(resolveTransferStrategy({ mode, dropTargetBeforeCreate: true })).toBe("rebuild");
  });

  it.each([
    ["append", { mode: "append", dropTargetBeforeCreate: false }],
    ["overwrite", { mode: "overwrite", dropTargetBeforeCreate: false }],
    ["upsert", { mode: "upsert", dropTargetBeforeCreate: false }],
    ["rebuild", { mode: "append", dropTargetBeforeCreate: true }],
  ] as const)("maps %s to one backend strategy", (strategy, options) => {
    expect(transferStrategyOptions(strategy)).toEqual(options);
    expect(resolveTransferStrategy(options)).toBe(strategy);
  });

  it("defaults legacy tasks without strategy fields to append", () => {
    expect(resolveTransferStrategy({})).toBe("append");
  });

  it("does not expose unimplemented DB2 or Xugu upsert or rebuild strategies", () => {
    expect(supportsTransferUpsert("db2")).toBe(false);
    expect(rebuildUnavailableReason("structureAndData", "db2")).toBe("unsupported");
    expect(rebuildUnavailableReason("structureOnly", "db2")).toBe("unsupported");
    expect(supportsTransferUpsert("postgres")).toBe(true);
    expect(supportsTransferUpsert("mysql")).toBe(true);
    expect(supportsTransferUpsert("xugu")).toBe(false);
    expect(supportsTransferUpsert(undefined)).toBe(true);
  });

  it.each([
    ["dataOnly", "postgres", "dataOnly"],
    ["structureAndData", "mongodb", "unsupported"],
    ["structureOnly", "postgres", undefined],
    ["structureAndData", "sqlite", undefined],
    ["structureAndData", undefined, "unsupported"],
  ] as const)("explains rebuild availability for %s and %s", (content, type, reason) => {
    expect(rebuildUnavailableReason(content, type)).toBe(reason);
  });
});

describe("transfer submission", () => {
  it.each(["create", "replace"] as const)("requires credentials only for the %s link in a mixed skip plan", async (action) => {
    const execute = vi.fn();
    const configs = ["SKIP", "WRITE"].map((name) => ({ objectType: "DB_LINK" as const, name, sourceOwner: "SOURCE", targetName: name, targetScope: "private" as const, authentication: "fixedUser" as const, username: "REMOTE", host: "connect-string", credentialAvailable: false }));
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: {
        canExecute: true,
        items: [
          { objectType: "DB_LINK", name: "SKIP", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "skip", ddl: "", credentialRequired: false, dependencies: [], warnings: [], errors: [] },
          { objectType: "DB_LINK", name: "WRITE", sourceSchema: "SOURCE", targetSchema: "TARGET", action, ddl: "", credentialRequired: true, dependencies: [], warnings: [], errors: [] },
        ],
      },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm: async () => true, execute });
    const input = request({ tables: [], objects: [{ objectType: "DB_LINK", names: ["SKIP", "WRITE"] }], dropTargetBeforeCreate: false, databaseLinks: configs });
    await expect(submission.start(input)).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    configs[1]!.credentialAvailable = true;
    await expect(submission.start(input)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].databaseLinks[0].credentialAvailable).toBe(false);
  });

  it("dispatches a credential-free skip-only link plan", async () => {
    const execute = vi.fn();
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "PUBLIC_DB_LINK", name: "L", sourceSchema: "PUBLIC", targetSchema: "PUBLIC", action: "skip", ddl: "", credentialRequired: false, dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm: async () => true, execute });
    await expect(
      submission.start(
        request({
          tables: [],
          objects: [{ objectType: "PUBLIC_DB_LINK", names: ["L"] }],
          dropTargetBeforeCreate: false,
          databaseLinks: [{ objectType: "PUBLIC_DB_LINK", name: "L", sourceOwner: "PUBLIC", targetName: "L", targetScope: "public", authentication: "fixedUser", username: "REMOTE", host: "connect-string", credentialAvailable: false }],
        }),
      ),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reviews type prerequisites before referencing table DDL and deferred bodies after programs", () => {
    const common = { sourceSchema: "SOURCE", targetSchema: "TARGET", action: "create" as const, dependencies: [], warnings: [], errors: [] };
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      structure: { sql: 'CREATE TABLE "TARGET"."PAYLOAD" (value "TARGET"."T");', tables: [], operations: [] },
      schemaObjects: {
        canExecute: true,
        items: [
          { ...common, objectType: "DB_LINK", name: "L", ddl: "-- Create DBLink L using supplied credentials" },
          { ...common, objectType: "TYPE", name: "T", executionPhase: "beforeTables", ddl: 'CREATE TYPE "TARGET"."T" AS OBJECT (n NUMBER);' },
          { ...common, objectType: "PACKAGE", name: "P", ddl: 'CREATE PACKAGE "TARGET"."P" AS PROCEDURE p; END;' },
          { ...common, objectType: "TYPE_BODY", name: "T", executionPhase: "afterObjects", ddl: 'CREATE TYPE BODY "TARGET"."T" AS MEMBER PROCEDURE p IS BEGIN "TARGET"."P".p; END; END;' },
        ],
      },
    };
    expect(transferPreviewSql(plan)).toBe([plan.schemaObjects!.items[0]!.ddl, plan.schemaObjects!.items[1]!.ddl, plan.structure!.sql, plan.schemaObjects!.items[2]!.ddl, plan.schemaObjects!.items[3]!.ddl].join("\n\n"));
  });
  it("cannot dispatch a DBLink with missing credentials even if a confirmation accepts it", async () => {
    const execute = vi.fn();
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "DB_LINK", name: "L", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "create", ddl: "-- Create DBLink L using credentials supplied for this run", credentialRequired: true, dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm: async () => true, execute });
    await expect(
      submission.start(
        request({
          tables: [],
          objects: [{ objectType: "DB_LINK", names: ["L"] }],
          dropTargetBeforeCreate: false,
          databaseLinks: [{ objectType: "DB_LINK", name: "L", sourceOwner: "SOURCE", targetName: "L", targetScope: "private", authentication: "fixedUser", username: "REMOTE", host: "connect-string", credentialAvailable: false }],
        }),
      ),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("freezes the target DBLink scope before asynchronous confirmation", async () => {
    const decision = deferred<boolean>();
    const execute = vi.fn();
    const confirm = vi.fn(() => decision.promise);
    const config = { objectType: "PUBLIC_DB_LINK" as const, name: "L", sourceOwner: "PUBLIC", targetName: "L", targetScope: "tenant" as const, authentication: "fixedUser" as const, username: "REMOTE", host: "connect-string", credentialAvailable: true };
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "PUBLIC_DB_LINK", name: "L", sourceSchema: "PUBLIC", targetSchema: "PUBLIC", action: "create", ddl: "-- Create tenant-visible DBLink L", dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm, execute });
    const pending = submission.start(request({ tables: [], objects: [{ objectType: "PUBLIC_DB_LINK", names: ["L"] }], dropTargetBeforeCreate: false, databaseLinks: [config] }));
    config.targetName = "UNREVIEWED";
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    decision.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(execute.mock.calls[0]![0].databaseLinks[0].targetName).toBe("L");
  });
  it("does not accept a private synonym plan for a same-named selected public synonym", async () => {
    const execute = vi.fn();
    const confirm = vi.fn();
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "SYNONYM", name: "S", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "create", ddl: 'CREATE SYNONYM "TARGET"."S" FOR "TARGET"."T"', dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm, execute });
    await expect(submission.start(request({ tables: [], objects: [{ objectType: "PUBLIC_SYNONYM", names: ["S"] }], dropTargetBeforeCreate: false }))).rejects.toThrow("TRANSFER_OBJECT_PREVIEW_UNAVAILABLE");
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reviews the original remote synonym reference without expanding it to a table transfer", async () => {
    const execute = vi.fn();
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: {
        canExecute: true,
        items: [
          {
            objectType: "PUBLIC_SYNONYM",
            name: "Remote S",
            sourceSchema: "PUBLIC",
            targetSchema: "PUBLIC",
            action: "create",
            ddl: 'CREATE PUBLIC SYNONYM "Remote S" FOR "REMOTE_OWNER"."T"@"REMOTE_LINK"',
            dependencies: [{ owner: "TARGET", name: "REMOTE_LINK", objectType: "DB_LINK", available: true }],
            warnings: ["Remote object not validated"],
            errors: [],
          },
        ],
      },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm: async () => true, execute });
    const input = request({ tables: [], objects: [{ objectType: "PUBLIC_SYNONYM", names: ["Remote S"] }], dropTargetBeforeCreate: false });
    await expect(submission.start(input)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tables: [], objects: input.objects }));
    expect(transferPreviewSql(plan)).toBe(plan.schemaObjects!.items[0]!.ddl);
  });
  it("requires a complete package plan without adding an unselected body", async () => {
    const execute = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "PACKAGE", name: "Keep Case", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "replace", ddl: 'CREATE OR REPLACE PACKAGE "TARGET"."Keep Case" AS PROCEDURE p; END;', dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm, execute });
    const input = request({ tables: [], objects: [{ objectType: "PACKAGE", names: ["Keep Case"] }], dropTargetBeforeCreate: false, objectConflictPolicy: "replace" });
    await expect(submission.start(input)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ objects: input.objects, objectConflictPolicy: "replace" }));
    expect(transferPreviewSql(plan)).toBe(plan.schemaObjects!.items[0]!.ddl);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), plan);
  });

  it.each(["PACKAGE_BODY", "TYPE", "TYPE_BODY"] as const)("refuses a selected %s missing from the backend plan", async (objectType) => {
    const execute = vi.fn();
    const confirm = vi.fn();
    const submission = createTransferSubmission({ preview: async () => ({ missingOwners: [], targetOwner: "TARGET", schemaObjects: { canExecute: true, items: [] } }), confirmOwnership: async () => "preserve", confirm, execute });
    await expect(submission.start(request({ tables: [], objects: [{ objectType, names: ["P"] }], dropTargetBeforeCreate: false }))).rejects.toThrow("TRANSFER_OBJECT_PREVIEW_UNAVAILABLE");
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not accept a type definition plan for the same-named type body", async () => {
    const execute = vi.fn();
    const confirm = vi.fn();
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: { canExecute: true, items: [{ objectType: "TYPE", name: "Case T", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "create", ddl: 'CREATE TYPE "TARGET"."Case T" AS OBJECT (n NUMBER)', dependencies: [], warnings: [], errors: [] }] },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm, execute });
    await expect(submission.start(request({ tables: [], objects: [{ objectType: "TYPE_BODY", names: ["Case T"] }], dropTargetBeforeCreate: false }))).rejects.toThrow("TRANSFER_OBJECT_PREVIEW_UNAVAILABLE");
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows blocked package dependencies but cannot execute even if confirmation returns true", async () => {
    const execute = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    const plan: TransferOwnershipPreview = {
      missingOwners: [],
      targetOwner: "TARGET",
      schemaObjects: {
        canExecute: false,
        items: [{ objectType: "PACKAGE_BODY", name: "P", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "blocked", ddl: "", dependencies: [{ owner: "TARGET", name: "P", objectType: "PACKAGE", available: false }], warnings: [], errors: ["Package specification missing"] }],
      },
    };
    const submission = createTransferSubmission({ preview: async () => plan, confirmOwnership: async () => "preserve", confirm, execute });
    await expect(submission.start(request({ tables: [], objects: [{ objectType: "PACKAGE_BODY", names: ["P"] }], dropTargetBeforeCreate: false }))).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), plan);
    expect(execute).not.toHaveBeenCalled();
    expect(transferPreviewSql(plan)).toBe("");
  });

  it("reviews backend SQL and executes the frozen request only after confirmation", async () => {
    const decision = deferred<boolean>();
    const reviewed: Array<{ request: TransferRequest; preview: TransferOwnershipPreview }> = [];
    const executions: TransferRequest[] = [];
    const previews: TransferRequest[] = [];
    const submission = createTransferSubmission({
      preview: async (value) => {
        previews.push(value);
        return preview();
      },
      confirmOwnership: async () => "preserve",
      confirm: (value, plan) => {
        reviewed.push({ request: value, preview: plan });
        return decision.promise;
      },
      execute: (value) => {
        executions.push(value);
      },
    });
    const input = request({ mode: "upsert", dropTargetConfirmed: true });

    const pending = submission.start(input);
    input.targetDatabase = "changed";
    input.tables.push("Unreviewed");
    input.objects[0]!.names.push("Unreviewed");
    await vi.waitFor(() => expect(reviewed).toHaveLength(1));

    expect(previews[0]).toMatchObject({ transferId: "transfer-1", targetDatabase: "warehouse", mode: "append", tables: ["Orders"], objects: [{ objectType: "TABLE", names: ["Orders"] }], dropTargetConfirmed: false });
    expect(() => previews[0]!.tables.push("Mutated")).toThrow();
    expect(reviewed[0]?.preview.rebuild?.sql).toBe('ALTER TABLE "reporting"."orders" RENAME TO "orders__dbx_bak_123";\nCREATE TABLE "reporting"."orders" ("id" INTEGER);');
    expect(executions).toEqual([]);

    decision.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(executions).toEqual([{ ...previews[0], dropTargetConfirmed: true }]);
    expect(previews[0]?.dropTargetConfirmed).toBe(false);
  });

  it("discards a preview after the form or dialog invalidates its submission", async () => {
    const backend = deferred<TransferOwnershipPreview>();
    const reviewed: TransferRequest[] = [];
    const executions: TransferRequest[] = [];
    const submission = createTransferSubmission({
      preview: () => backend.promise,
      confirmOwnership: async () => "preserve",
      confirm: async (value) => {
        reviewed.push(value);
        return true;
      },
      execute: (value) => {
        executions.push(value);
      },
    });

    const pending = submission.start(request());
    submission.cancel();
    backend.resolve(preview({ missingOwners: ["old_owner"] }));

    await expect(pending).resolves.toBe(false);
    expect(reviewed).toEqual([]);
    expect(executions).toEqual([]);
  });

  it("does not execute an older confirmation after a newer transfer starts", async () => {
    const decision = deferred<boolean>();
    const executions: TransferRequest[] = [];
    let confirmationCount = 0;
    const submission = createTransferSubmission({
      preview: async () => preview(),
      confirmOwnership: async () => "preserve",
      confirm: async (value) => {
        confirmationCount++;
        return value.transferId === "old" ? decision.promise : true;
      },
      execute: (value) => {
        executions.push(value);
      },
    });

    const old = submission.start(request({ transferId: "old" }));
    await vi.waitFor(() => expect(confirmationCount).toBe(1));
    await expect(submission.start(request({ transferId: "new" }))).resolves.toBe(true);
    decision.resolve(true);

    await expect(old).resolves.toBe(false);
    expect(executions.map((value) => value.transferId)).toEqual(["new"]);
  });

  it("re-previews a changed ownership policy with the same transfer ID before final confirmation", async () => {
    const previews: TransferRequest[] = [];
    const reviewed: TransferOwnershipPreview[] = [];
    const executions: TransferRequest[] = [];
    const submission = createTransferSubmission({
      preview: async (value) => {
        previews.push(value);
        return preview({ missingOwners: ["old_owner"], rebuild: { ...preview().rebuild!, sql: value.ownershipPolicy === "reassignMissing" ? "REASSIGNED PLAN" : "ORIGINAL PLAN" } });
      },
      confirmOwnership: async () => "reassignMissing",
      confirm: async (_value, plan) => {
        reviewed.push(plan);
        return true;
      },
      execute: (value) => {
        executions.push(value);
      },
    });

    await expect(submission.start(request())).resolves.toBe(true);

    expect(previews.map((value) => [value.transferId, value.ownershipPolicy, value.dropTargetConfirmed])).toEqual([
      ["transfer-1", "preserve", false],
      ["transfer-1", "reassignMissing", false],
    ]);
    expect(reviewed.map((value) => value.rebuild?.sql)).toEqual(["REASSIGNED PLAN"]);
    expect(executions[0]?.ownershipPolicy).toBe("reassignMissing");
  });

  it("refuses rebuild execution when the backend does not provide a rebuild plan", async () => {
    const executions: TransferRequest[] = [];
    const submission = createTransferSubmission({
      preview: async () => preview({ rebuild: undefined }),
      confirmOwnership: async () => "preserve",
      confirm: async () => true,
      execute: (value) => {
        executions.push(value);
      },
    });

    await expect(submission.start(request())).rejects.toThrow("TRANSFER_REBUILD_PREVIEW_UNAVAILABLE");
    expect(executions).toEqual([]);
  });

  it("does not surface errors from a cancelled preview", async () => {
    const backend = deferred<TransferOwnershipPreview>();
    const submission = createTransferSubmission({ preview: () => backend.promise, confirmOwnership: async () => null, confirm: async () => false, execute: () => undefined });
    const pending = submission.start(request());
    submission.cancel();
    backend.reject(new Error("old connection failed"));

    await expect(pending).resolves.toBe(false);
  });

  it.each(["append", "overwrite", "upsert"] as const)("keeps ordinary %s data-only requests free of rebuild authorization", async (mode) => {
    const executions: TransferRequest[] = [];
    const submission = createTransferSubmission({
      preview: async () => {
        throw new Error("Data-only must not load DDL preview");
      },
      confirmOwnership: async () => null,
      confirm: async () => true,
      execute: (value) => {
        executions.push(value);
      },
    });

    await submission.start(request({ content: "dataOnly", createTable: false, mode, dropTargetBeforeCreate: false, dropTargetConfirmed: true }));

    expect(executions[0]).toMatchObject({ mode, content: "dataOnly", createTable: false, dropTargetBeforeCreate: false, dropTargetConfirmed: false });
  });
});

describe("transfer production confirmation", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
    return { id: "target", name: "Warehouse", db_type: "postgres", host: "localhost", port: 5432, username: "target_user", password: "", ...overrides };
  }

  it.each([{ is_production: true }, { production_databases: ["warehouse"] }])("uses one shared confirmation for production scope %j", async (scope) => {
    let ordinaryConfirmations = 0;
    const pending = confirmTransferWithProductionSafety({
      request: request(),
      connection: connection(scope),
      reviewText: preview().rebuild!.sql,
      source: "Data Transfer",
      confirm: async () => {
        ordinaryConfirmations++;
        return true;
      },
    });

    const store = useProductionSafetyStore();
    expect(store.pending).toMatchObject({ scopeId: "transfer-1", database: "warehouse", connectionName: "Warehouse", sql: preview().rebuild!.sql });
    expect(ordinaryConfirmations).toBe(0);

    store.confirm();
    await expect(pending).resolves.toBe(true);
    expect(store.pending).toBeUndefined();
  });

  it("cancels a pending production confirmation with the transfer scope", async () => {
    const pending = confirmTransferWithProductionSafety({ request: request(), connection: connection({ production_databases: ["warehouse"] }), reviewText: "PLAN", confirm: async () => true });

    useProductionSafetyStore().cancelScope("transfer-1");

    await expect(pending).resolves.toBe(false);
    expect(useProductionSafetyStore().pending).toBeUndefined();
  });

  it("uses the transfer confirmation for a non-production target", async () => {
    let ordinaryConfirmations = 0;
    const result = await confirmTransferWithProductionSafety({
      request: request(),
      connection: connection(),
      reviewText: "PLAN",
      confirm: async () => {
        ordinaryConfirmations++;
        return false;
      },
    });

    expect(result).toBe(false);
    expect(ordinaryConfirmations).toBe(1);
    expect(useProductionSafetyStore().pending).toBeUndefined();
  });
});
