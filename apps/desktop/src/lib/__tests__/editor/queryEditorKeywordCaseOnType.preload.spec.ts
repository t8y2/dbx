import { describe, expect, it, vi } from "vitest";
import { loadedSqlFormatterEngine } from "@/lib/sql/layout/internals";
import { createQueryEditorKeywordCaseOnTypeFilter } from "@/lib/editor/queryEditorKeywordCaseOnType";

// Deliberately does NOT preload the engine: this file pins the lazy-load policy
// of the filter factory. Vitest isolates module state per test file.

function options(enabled: boolean) {
  return { enabled: () => enabled, keywordCase: () => "upper" as const, dialect: () => "mysql" as const, databaseType: () => "mysql" as const };
}

describe("typing-time keyword case engine preload", () => {
  it("stays lazy while the feature is off", async () => {
    createQueryEditorKeywordCaseOnTypeFilter(options(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loadedSqlFormatterEngine()).toBeNull();
  });

  it("preloads the formatter engine when the feature is on", async () => {
    createQueryEditorKeywordCaseOnTypeFilter(options(true));
    await vi.waitFor(() => expect(loadedSqlFormatterEngine()).not.toBeNull(), { timeout: 10_000 });
  });
});
