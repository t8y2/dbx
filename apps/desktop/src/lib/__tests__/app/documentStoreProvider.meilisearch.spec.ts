import { describe, expect, it } from "vitest";
import { documentFilterModeOptionsFor, documentStoreProviderFor } from "@/lib/app/documentStoreProvider";

describe("Meilisearch document store provider", () => {
  it("uses a dedicated provider and describes the DBX fetch operation", () => {
    const provider = documentStoreProviderFor("meilisearch");

    expect(provider.kind).toBe("meilisearch");
    expect(
      provider.queryPreview({
        collection: "movies",
        filterJson: '{"status":"published"}',
        sortJson: '{"rating":-1}',
        skip: 20,
        limit: 10,
      }),
    ).toBe('DBX MEILISEARCH FETCH DOCUMENTS\nindex: "movies"\noffset: 20\nlimit: 10\nfilter:\n{\n  "status": "published"\n}\nsort:\n{\n  "rating": -1\n}');
  });

  it("does not offer structured contains modes by default", () => {
    expect(documentFilterModeOptionsFor("meilisearch").map((option) => option.value)).not.toEqual(expect.arrayContaining(["like", "not-like"]));
    expect(documentFilterModeOptionsFor("elasticsearch").map((option) => option.value)).toEqual(expect.arrayContaining(["like", "not-like"]));
  });
});
