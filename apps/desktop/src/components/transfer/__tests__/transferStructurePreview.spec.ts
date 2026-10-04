import { describe, expect, it, vi } from "vitest";
import type { TransferOwnershipPreview, TransferRequest } from "@/lib/backend/api";
import { createTransferSubmission, hasTransferSqlPreview, transferPreviewSql, TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE } from "../transferStrategy";

function structureRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    transferId: "transfer-1",
    sourceConnectionId: "source",
    sourceDatabase: "app",
    sourceSchema: "public",
    targetConnectionId: "target",
    targetDatabase: "warehouse",
    targetSchema: "reporting",
    tables: ["orders"],
    objects: [{ objectType: "TABLE", names: ["orders"] }],
    createTable: true,
    content: "structureOnly",
    mode: "append",
    targetTableNameCase: "preserve",
    quoteTargetColumnNames: true,
    ownershipPolicy: "preserve",
    batchSize: 1000,
    dropTargetBeforeCreate: false,
    dropTargetConfirmed: false,
    ...overrides,
  };
}

function structurePreview(sql = '-- orders -> reporting.orders\nCREATE TABLE "reporting"."orders" ("id" integer);'): TransferOwnershipPreview["structure"] {
  return { sql, tables: [{ sourceTable: "orders", targetTable: "reporting.orders", preexisting: false, sql }] };
}

function preview(overrides: Partial<TransferOwnershipPreview> = {}): TransferOwnershipPreview {
  return { missingOwners: [], targetOwner: "", structure: structurePreview(), ...overrides };
}

/** Collects what the submission asked for, so a refused transfer is visible as "no execute". */
function submissionHarness(backendPreview: (request: TransferRequest) => Promise<TransferOwnershipPreview>, confirmed = true) {
  const previews: TransferRequest[] = [];
  const reviewed: Array<{ request: TransferRequest; preview: TransferOwnershipPreview }> = [];
  const executions: TransferRequest[] = [];
  const submission = createTransferSubmission({
    preview: async (request) => {
      previews.push(request);
      return backendPreview(request);
    },
    confirmOwnership: async () => "preserve",
    confirm: async (request, plan) => {
      reviewed.push({ request, preview: plan });
      return confirmed;
    },
    execute: (request) => {
      executions.push(request);
    },
  });
  return { submission, previews, reviewed, executions };
}

describe("structure-only SQL preview", () => {
  it("reviews the planned structure SQL and executes only after confirmation", async () => {
    const harness = submissionHarness(async () => preview());

    await expect(harness.submission.start(structureRequest())).resolves.toBe(true);

    expect(harness.previews).toHaveLength(1);
    expect(harness.reviewed[0]?.preview.structure?.sql).toContain("CREATE TABLE");
    expect(transferPreviewSql(harness.reviewed[0]!.preview)).toContain('CREATE TABLE "reporting"."orders"');
    expect(hasTransferSqlPreview(harness.reviewed[0]!.preview)).toBe(true);
    expect(harness.executions).toHaveLength(1);
    expect(harness.executions[0]?.content).toBe("structureOnly");
  });

  it("does not execute when the SQL confirmation is cancelled", async () => {
    const harness = submissionHarness(async () => preview(), false);

    await expect(harness.submission.start(structureRequest())).resolves.toBe(false);

    expect(harness.reviewed).toHaveLength(1);
    expect(harness.executions).toEqual([]);
  });

  it("fails closed when the backend returns no structure preview", async () => {
    const harness = submissionHarness(async () => ({ missingOwners: [], targetOwner: "" }));

    await expect(harness.submission.start(structureRequest())).rejects.toThrow(TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE);

    expect(harness.reviewed).toEqual([]);
    expect(harness.executions).toEqual([]);
  });

  it("places the structure plan between the rebuild rename and cleanup phases without repeating either", () => {
    const composed = transferPreviewSql({
      missingOwners: [],
      targetOwner: "",
      structure: structurePreview("CREATE TABLE users (id integer);"),
      rebuild: {
        sql: "COMBINED PLAN",
        tables: [{ sourceTable: "users", targetTable: "users", backupTable: "users__dbx_bak_1" }],
        backupSql: "ALTER TABLE users RENAME TO users__dbx_bak_1;",
        cleanupSql: "DROP TABLE users__dbx_bak_1;",
      },
    });

    expect(composed.split("\n\n")).toEqual(["ALTER TABLE users RENAME TO users__dbx_bak_1;", "CREATE TABLE users (id integer);", "DROP TABLE users__dbx_bak_1;"]);
    expect(composed).not.toContain("COMBINED PLAN");
  });

  it("keeps the combined rebuild plan for rebuilds without a structure preview", () => {
    const composed = transferPreviewSql({
      missingOwners: [],
      targetOwner: "",
      rebuild: {
        sql: "COMBINED PLAN",
        tables: [{ sourceTable: "users", targetTable: "users", backupTable: "users__dbx_bak_1" }],
      },
    });

    expect(composed).toBe("COMBINED PLAN");
    expect(hasTransferSqlPreview({ missingOwners: [], targetOwner: "", rebuild: { sql: "PLAN", tables: [] } })).toBe(true);
  });

  it("does not request a structure preview for data-only transfers", async () => {
    const harness = submissionHarness(async () => {
      throw new Error("Data-only must not load the structure preview");
    });

    await expect(harness.submission.start(structureRequest({ content: "dataOnly", createTable: false }))).resolves.toBe(true);

    expect(harness.previews).toEqual([]);
    expect(harness.executions).toHaveLength(1);
  });

  it("keeps structure-and-data transfers on the existing confirmation path", async () => {
    const harness = submissionHarness(async () => ({ missingOwners: [], targetOwner: "" }));

    await expect(harness.submission.start(structureRequest({ content: "structureAndData", tables: ["orders"] }))).resolves.toBe(true);

    expect(harness.previews).toHaveLength(1);
    expect(harness.reviewed[0]?.preview.structure).toBeUndefined();
    expect(hasTransferSqlPreview(harness.reviewed[0]!.preview)).toBe(false);
    expect(harness.executions).toHaveLength(1);
  });

  it("still refuses a rebuild that has no rebuild plan", async () => {
    const harness = submissionHarness(async () => ({ missingOwners: [], targetOwner: "", structure: structurePreview() }));

    await expect(harness.submission.start(structureRequest({ dropTargetBeforeCreate: true }))).rejects.toThrow("TRANSFER_REBUILD_PREVIEW_UNAVAILABLE");

    expect(harness.executions).toEqual([]);
  });

  it("refuses a structure-only transfer whose preview is missing even when ownership was re-confirmed", async () => {
    const executions: TransferRequest[] = [];
    let previewCalls = 0;
    const confirmations = vi.fn(async () => true);
    const submission = createTransferSubmission({
      preview: async () => {
        previewCalls += 1;
        return previewCalls === 1 ? { missingOwners: ["old_owner"], targetOwner: "target_user", structure: structurePreview() } : { missingOwners: [], targetOwner: "" };
      },
      confirmOwnership: async () => "reassignMissing",
      confirm: confirmations,
      execute: (request) => {
        executions.push(request);
      },
    });

    await expect(submission.start(structureRequest())).rejects.toThrow(TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE);

    expect(confirmations).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
  });
});
