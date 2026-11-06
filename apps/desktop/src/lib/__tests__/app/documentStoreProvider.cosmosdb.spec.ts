import { describe, expect, it, vi } from "vitest";
import { formatDocumentStoreIdLabel, serializeDocumentStoreId } from "@/lib/app/documentJsonValues";
import { buildDocumentFilterCondition, documentFilterModeOptionsFor, documentStoreProviderFor } from "@/lib/app/documentStoreProvider";
import { applyDocumentStoreIdentityPlan, insertDocumentStoreDocument } from "@/lib/app/documentStoreSave";

describe("Azure Cosmos DB document store provider", () => {
  it("uses a dedicated provider and previews the container query", () => {
    const provider = documentStoreProviderFor("cosmosdb");

    expect(provider.kind).toBe("cosmosdb");
    expect(provider.queryPreview({ collection: "orders", filterJson: '{"status":"open"}', sortJson: '{"ts":-1}', skip: 0, limit: 50 })).toBe('DBX COSMOSDB QUERY DOCUMENTS\ncontainer: "orders"\nlimit: 50\nfilter:\n{\n  "status": "open"\n}\nsort:\n{\n  "ts": -1\n}');
    expect(provider.documentsLabel({ total: 21, totalIsExact: false, t: ((key: string) => key) as never })).toBe("≥21 Documents");
  });

  it("labels documents by id, adding the partition key when it differs", () => {
    expect(formatDocumentStoreIdLabel({ id: "order-1", partitionKey: ["order-1"] }, "cosmosdb")).toBe("order-1");
    expect(formatDocumentStoreIdLabel({ id: "order-1", partitionKey: ["tenant-a", 7] }, "cosmosdb")).toBe('order-1 · "tenant-a" / 7');
    expect(formatDocumentStoreIdLabel({ id: "order-1", partitionKey: [{}] }, "cosmosdb")).toBe("order-1 · undefined");
  });

  it("serializes the id and partition key identity as JSON", () => {
    expect(serializeDocumentStoreId({ id: "order-1", partitionKey: ["tenant-a"] }, "cosmosdb")).toBe('{"id":"order-1","partitionKey":["tenant-a"]}');
  });

  it("offers the Mongo-style operators the driver translates to Cosmos SQL", () => {
    const modes = documentFilterModeOptionsFor("cosmosdb").map((option) => option.value);
    expect(modes).toEqual(expect.arrayContaining(["in", "not-in", "between", "begins-with", "is-null"]));
    expect(buildDocumentFilterCondition({ id: "like", fieldName: "customer", mode: "like", rawValue: "Acme", conjunction: "AND" }, { kind: "cosmosdb" })).toEqual({ customer: { $regex: "Acme", $options: "i" } });
    expect(buildDocumentFilterCondition({ id: "in", fieldName: "status", mode: "in", rawValue: "open, closed", conjunction: "AND" }, { kind: "cosmosdb" })).toEqual({ status: { $in: ["open", "closed"] } });
  });

  it("always inserts new documents; the backend derives their identity", async () => {
    const insert = vi.fn(async () => "created");
    const update = vi.fn(async () => 1);

    await insertDocumentStoreDocument({
      kind: "cosmosdb",
      explicitId: '{"id":"order-1","partitionKey":["tenant-a"]}',
      document: { id: "order-1", tenant: "tenant-a" },
      apis: { insert, update },
    });

    expect(insert).toHaveBeenCalledWith('{"id":"order-1","tenant":"tenant-a"}', undefined);
    expect(update).not.toHaveBeenCalled();
  });

  it("sends partition key changes to the backend keyed by the loaded identity", async () => {
    const insert = vi.fn(async () => "created");
    const update = vi.fn(async () => 1);
    const remove = vi.fn(async () => 1);

    await applyDocumentStoreIdentityPlan({
      kind: "cosmosdb",
      plan: { action: "rekey", writeId: '{"id":"order-1","partitionKey":["tenant-b"]}', deleteId: '{"id":"order-1","partitionKey":["tenant-a"]}' },
      document: { id: "order-1", tenant: "tenant-b" },
      apis: { insert, update, delete: remove },
    });

    expect(update).toHaveBeenCalledWith('{"id":"order-1","partitionKey":["tenant-a"]}', '{"id":"order-1","tenant":"tenant-b"}', undefined);
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
