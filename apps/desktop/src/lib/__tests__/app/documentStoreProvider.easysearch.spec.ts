import { describe, expect, it } from "vitest";
import { documentStoreProviderFor } from "@/lib/app/documentStoreProvider";

describe("Easysearch document store provider", () => {
  it("uses the Elasticsearch-compatible document provider", () => {
    const provider = documentStoreProviderFor("easysearch");

    expect(provider.kind).toBe("elasticsearch");
    expect(
      provider.queryPreview({
        collection: "orders",
        filterJson: '{"status":"paid"}',
        sortJson: '{"created_at":-1}',
        skip: 0,
        limit: 100,
      }),
    ).toContain("POST /orders/_search");
  });
});
