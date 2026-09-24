import { describe, expect, it } from "vitest";
import { documentStoreProviderFor } from "@/lib/app/documentStoreProvider";

describe("Solr document store provider", () => {
  it("uses the Solr document provider", () => {
    const provider = documentStoreProviderFor("solr");

    expect(provider.kind).toBe("solr");
    const preview = provider.queryPreview({
      collection: "mycore",
      filterJson: '{"status":"paid"}',
      sortJson: '{"id":1}',
      skip: 0,
      limit: 100,
    });
    expect(preview).toContain("DBX SOLR QUERY DOCUMENTS");
    expect(preview).toContain('core: "mycore"');
    expect(preview).toContain("offset: 0");
    expect(preview).toContain("limit: 100");
    expect(preview).not.toContain("/_search");
    expect(preview).not.toContain("_routing");
  });
});
