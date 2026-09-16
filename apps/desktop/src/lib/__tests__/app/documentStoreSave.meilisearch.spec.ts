import { describe, expect, it, vi } from "vitest";
import { serializeDocumentStoreId } from "@/lib/app/documentJsonValues";
import { applyDocumentStoreIdentityPlan, formatMeilisearchDocumentOperationPreview } from "@/lib/app/documentStoreSave";
import { parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";

describe("Meilisearch document saves", () => {
  it("preserves the distinction between string and numeric document ids", () => {
    expect(serializeDocumentStoreId("001", "meilisearch")).toBe('__dbx_meilisearch_string_id__"001"');
    expect(serializeDocumentStoreId(1, "meilisearch")).toBe("1");
    expect(serializeDocumentStoreId(parseJsonPreservingLargeNumbers("9007199254740993"), "meilisearch")).toBe("9007199254740993");
  });

  it("describes DBX write semantics without inventing a native primary-key field", () => {
    const preview = formatMeilisearchDocumentOperationPreview({
      action: "update",
      index: "movies",
      id: "001",
      document: { title: "Arrival", rating: 9 },
    });

    expect(preview).toContain("DBX MEILISEARCH UPDATE DOCUMENT");
    expect(preview).toContain('index: "movies"');
    expect(preview).toContain('id: "001"');
    expect(preview).toContain('"title": "Arrival"');
    expect(preview).not.toContain("PUT /indexes/");
  });

  it("writes the new identity before deleting the old document", async () => {
    const calls: string[] = [];
    const update = vi.fn(async (id: string) => {
      calls.push(`update:${id}`);
      return 1;
    });
    const remove = vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
      return 1;
    });

    await applyDocumentStoreIdentityPlan({
      kind: "meilisearch",
      plan: {
        action: "rekey",
        writeId: serializeDocumentStoreId("002", "meilisearch"),
        deleteId: serializeDocumentStoreId("001", "meilisearch"),
      },
      document: { _id: "002", title: "Arrival" },
      apis: {
        insert: vi.fn(async () => ""),
        update,
        delete: remove,
      },
    });

    expect(calls).toEqual(['update:__dbx_meilisearch_string_id__"002"', 'delete:__dbx_meilisearch_string_id__"001"']);
    expect(update).toHaveBeenCalledWith('__dbx_meilisearch_string_id__"002"', '{"title":"Arrival"}', undefined);
  });
});
