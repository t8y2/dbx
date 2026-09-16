import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferOwnershipPreview, TransferRequest } from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { confirmTransferWithProductionSafety, createTransferSubmission, rebuildUnavailableReason, resolveTransferStrategy, transferStrategyOptions } from "../transferStrategy";

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
