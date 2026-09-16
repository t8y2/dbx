import { describe, expect, it } from "vitest";
import { serializeDocumentStoreId, stringifyDocumentStoreValue } from "@/lib/app/documentJsonValues";
import { decodeMeilisearchDocumentPage, decodeMeilisearchSearchResult } from "./meilisearchTransport";

describe("Meilisearch transport", () => {
  it("keeps large integer identities and document JSON exact", () => {
    const result = decodeMeilisearchSearchResult({
      hits: [
        {
          idJson: "9007199254740993",
          documentJson: '{"movie_id":9007199254740993,"title":"Alien"}',
        },
      ],
      totalHits: 1,
      processingTimeMs: 1,
    });

    expect(serializeDocumentStoreId(result.hits[0].id, "meilisearch")).toBe("9007199254740993");
    expect(stringifyDocumentStoreValue(result.hits[0].document, "meilisearch")).toBe('{"movie_id":9007199254740993,"title":"Alien"}');
  });

  it("decodes full-document export pages without rounding integers", () => {
    const page = decodeMeilisearchDocumentPage({
      documentsJson: ['{"movie_id":9007199254740993,"internal_notes":"secret"}'],
      total: 1,
    });

    expect(stringifyDocumentStoreValue(page.documents, "meilisearch")).toBe('[{"movie_id":9007199254740993,"internal_notes":"secret"}]');
  });
});
