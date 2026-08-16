import { describe, expect, it, vi } from "vitest";
import { formatDocumentStoreIdLabel, serializeDocumentStoreId } from "@/lib/app/documentJsonValues";
import { buildDocumentFilterCondition, currentDocumentFilterJson, documentStoreProviderFor } from "@/lib/app/documentStoreProvider";
import { applyDocumentStoreIdentityPlan, insertDocumentStoreDocument } from "@/lib/app/documentStoreSave";

describe("DynamoDB document store provider", () => {
  it("uses a dedicated provider and describes a cursor-backed read", () => {
    const provider = documentStoreProviderFor("dynamodb");

    expect(provider.kind).toBe("dynamodb");
    expect(
      provider.queryPreview({
        collection: "orders",
        filterJson: '{"tenant_id":"tenant-a","$index":"by_status"}',
        sortJson: '{"created_at":-1}',
        skip: 100,
        limit: 50,
      }),
    ).toContain('DBX DYNAMODB QUERY / SCAN\ntable: "orders"\nlimit: 50');
  });

  it("keeps composite key identity and large-number wrappers intact", () => {
    const id = {
      tenant_id: "tenant-a",
      sequence: { $dbxDynamoDb: { version: 1, type: "number", value: "9007199254740993" } },
    };

    expect(serializeDocumentStoreId(id, "dynamodb")).toBe('{"tenant_id":"tenant-a","sequence":{"$dbxDynamoDb":{"version":1,"type":"number","value":"9007199254740993"}}}');
    expect(formatDocumentStoreIdLabel(id, "dynamodb")).toBe('{"tenant_id":"tenant-a","sequence":{"$dbxDynamoDb":{"version":1,"type":"number","value":"9007199254740993"}}}');
  });

  it("builds DynamoDB-compatible structured filters", () => {
    expect(currentDocumentFilterJson("", { amount: { $gte: 50 } }, "dynamodb")).toBe('{"amount":{"$gte":50}}');
    expect(buildDocumentFilterCondition({ id: "contains", fieldName: "customer", mode: "like", rawValue: "Acme", conjunction: "AND" }, { kind: "dynamodb" })).toEqual({ customer: { $contains: "Acme" } });
    expect(buildDocumentFilterCondition({ id: "not-contains", fieldName: "customer", mode: "not-like", rawValue: "Test", conjunction: "AND" }, { kind: "dynamodb" })).toEqual({ customer: { $notContains: "Test" } });
  });

  it("uses conditional insert semantics even when a new item has an explicit identity", async () => {
    const insert = vi.fn(async () => "created");
    const update = vi.fn(async () => 1);

    await insertDocumentStoreDocument({
      kind: "dynamodb",
      explicitId: '{"tenant_id":"tenant-a","order_id":"order-1001"}',
      document: { tenant_id: "tenant-a", order_id: "order-1001", amount: 42 },
      apis: { insert, update },
    });

    expect(insert).toHaveBeenCalledWith('{"tenant_id":"tenant-a","order_id":"order-1001","amount":42}', undefined);
    expect(update).not.toHaveBeenCalled();
  });

  it("delegates a DynamoDB rekey to one atomic backend update", async () => {
    const calls: string[] = [];
    const insert = vi.fn(async () => {
      calls.push("insert");
      return "created";
    });
    const update = vi.fn(async () => {
      calls.push("update");
      return 1;
    });
    const remove = vi.fn(async () => {
      calls.push("delete");
      return 1;
    });

    await applyDocumentStoreIdentityPlan({
      kind: "dynamodb",
      plan: {
        action: "rekey",
        writeId: '{"tenant_id":"tenant-a","order_id":"order-1002"}',
        deleteId: '{"tenant_id":"tenant-a","order_id":"order-1001"}',
      },
      document: { tenant_id: "tenant-a", order_id: "order-1002", amount: 42 },
      apis: { insert, update, delete: remove },
    });

    expect(calls).toEqual(["update"]);
    expect(update).toHaveBeenCalledWith('{"tenant_id":"tenant-a","order_id":"order-1001"}', '{"tenant_id":"tenant-a","order_id":"order-1002","amount":42}', undefined);
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
