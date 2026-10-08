import { describe, expect, it } from "vitest";
import type { TransferStructureOperation } from "@/lib/backend/api";
import { describeTransferStructureOperation, summarizeTransferStructureOperations } from "../structurePlanSummary";

function operation(kind: TransferStructureOperation["kind"], values: Partial<Omit<TransferStructureOperation, "kind">> = {}): TransferStructureOperation {
  return { kind, ...values };
}

describe("transfer structure plan summary", () => {
  it("aggregates counts from operations and counts a sequence once across create and bind", () => {
    expect(
      summarizeTransferStructureOperations([
        operation("createSchema", { objectName: "reporting" }),
        operation("createTable", { sourceTable: "orders", targetTable: "orders" }),
        operation("createIndex", { objectName: "idx_orders_created_at" }),
        operation("addForeignKey", { objectName: "fk_orders_user" }),
        operation("createSequence", { objectName: "orders_id_seq" }),
        operation("bindSequence", { objectName: "orders_id_seq" }),
        operation("addComment"),
        operation("skipExistingTable", { targetTable: "users" }),
        operation("rebuildTable", { targetTable: "customers" }),
      ]),
    ).toEqual({
      createdSchemas: 1,
      createdTables: 1,
      indexes: 1,
      foreignKeys: 1,
      sequences: 1,
      comments: 1,
      skippedTables: 1,
      rebuiltTables: 1,
    });
  });

  it("retains object names and source-to-target mapping in display descriptions", () => {
    expect(describeTransferStructureOperation(operation("createTable", { sourceTable: "orders", targetTable: "reporting.orders" }))).toEqual({
      key: "transfer.structureOperationCreateTable",
      values: { name: "orders → reporting.orders" },
    });
    expect(describeTransferStructureOperation(operation("createIndex", { objectName: "idx_orders_created_at", targetTable: "orders" }))).toEqual({
      key: "transfer.structureOperationCreateIndex",
      values: { name: "idx_orders_created_at", table: "orders" },
    });
  });

  it("makes a skipped existing table explicit in the object list", () => {
    expect(describeTransferStructureOperation(operation("skipExistingTable", { targetTable: "users" }))).toEqual({
      key: "transfer.structureOperationSkipExistingTable",
      values: { name: "users" },
      suffixKey: "transfer.structurePlanTargetAlreadyExists",
    });
  });

  it("describes rebuild and column comment operations without interpreting SQL", () => {
    expect(describeTransferStructureOperation(operation("rebuildTable", { targetTable: "customers" }))).toEqual({
      key: "transfer.structureOperationRebuildTable",
      values: { name: "customers" },
    });
    expect(describeTransferStructureOperation(operation("addComment", { objectName: "created_at", targetTable: "orders" }))).toEqual({
      key: "transfer.structureOperationAddColumnComment",
      values: { table: "orders", column: "created_at" },
    });
  });
});
