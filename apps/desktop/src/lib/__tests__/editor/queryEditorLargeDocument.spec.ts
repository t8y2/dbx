import { describe, expect, it } from "vitest";
import {
  QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH,
  QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT,
  QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH,
  shouldParseQueryEditorSyntax,
  shouldUseQueryEditorLargeDocumentMode,
  shouldUseQueryEditorLargeDocumentModeForSize,
} from "@/lib/editor/queryEditorLargeDocument";

describe("query editor large document policy", () => {
  it("keeps the default feature set through the configured budget", () => {
    expect(shouldUseQueryEditorLargeDocumentMode("x".repeat(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH))).toBe(false);
  });

  it("switches to bounded features above the configured budget", () => {
    expect(shouldUseQueryEditorLargeDocumentMode("x".repeat(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH + 1))).toBe(true);
  });

  it("keeps full features through the configured line budget", () => {
    const document = Array.from({ length: QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT }, () => "SELECT 1;").join("\n");

    expect(shouldUseQueryEditorLargeDocumentMode(document)).toBe(false);
    expect(shouldUseQueryEditorLargeDocumentModeForSize(document.length, QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT)).toBe(false);
  });

  it("switches to bounded features above the configured line budget", () => {
    const lineCount = QUERY_EDITOR_FULL_FEATURE_MAX_LINE_COUNT + 1;
    const document = Array.from({ length: lineCount }, () => "SELECT 1;").join("\n");

    expect(document.length).toBeLessThan(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH);
    expect(shouldUseQueryEditorLargeDocumentMode(document)).toBe(true);
    expect(shouldUseQueryEditorLargeDocumentModeForSize(document.length, lineCount)).toBe(true);
  });

  it("parses syntax through the grammar budget and stops above it", () => {
    expect(shouldParseQueryEditorSyntax(QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH)).toBe(true);
    expect(shouldParseQueryEditorSyntax(QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH + 1)).toBe(false);
  });

  it("keeps the grammar budget above the bounded-analysis budget so the grammar covers every ordinary document", () => {
    expect(QUERY_EDITOR_SYNTAX_PARSE_MAX_DOCUMENT_LENGTH).toBeGreaterThan(QUERY_EDITOR_FULL_FEATURE_MAX_DOCUMENT_LENGTH);
  });
});
