import { describe, expect, it } from "vitest";
import { QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH, shouldUseQueryEditorLargeDocumentMode } from "@/lib/editor/queryEditorLargeDocument";

describe("query editor large document policy", () => {
  it("keeps the default feature set through the configured budget", () => {
    expect(shouldUseQueryEditorLargeDocumentMode("x".repeat(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH))).toBe(false);
  });

  it("switches to bounded features above the configured budget", () => {
    expect(shouldUseQueryEditorLargeDocumentMode("x".repeat(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1))).toBe(true);
  });
});
