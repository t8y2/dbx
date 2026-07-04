import { describe, expect, it } from "vitest";
import { usesLocalOnlyEditorCompletionMetadata, usesOnDemandOnlyEditorColumnMetadata } from "@/lib/metadata/completionMetadataPolicy";

describe("completionMetadataPolicy", () => {
  it("keeps Presto-like editor completion on local metadata", () => {
    expect(usesLocalOnlyEditorCompletionMetadata("prestosql")).toBe(true);
    expect(usesLocalOnlyEditorCompletionMetadata("trino")).toBe(true);
  });

  it("does not change regular database completion behavior", () => {
    expect(usesLocalOnlyEditorCompletionMetadata("mysql")).toBe(false);
    expect(usesLocalOnlyEditorCompletionMetadata("postgres")).toBe(false);
    expect(usesLocalOnlyEditorCompletionMetadata("jdbc")).toBe(false);
    expect(usesLocalOnlyEditorCompletionMetadata(undefined)).toBe(false);
  });

  it("keeps Presto-like editor column metadata on demand only", () => {
    expect(usesOnDemandOnlyEditorColumnMetadata("prestosql")).toBe(true);
    expect(usesOnDemandOnlyEditorColumnMetadata("trino")).toBe(true);
    expect(usesOnDemandOnlyEditorColumnMetadata("mysql")).toBe(false);
    expect(usesOnDemandOnlyEditorColumnMetadata(undefined)).toBe(false);
  });
});
