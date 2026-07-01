import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, type AiContext } from "@/lib/ai";

// buildSystemPrompt switches copy by currentLocale(); pin it to English so the assertions below
// (which check the English prompt text) are stable regardless of the host locale.
vi.mock("@/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n")>();
  return { ...actual, currentLocale: () => "en" };
});

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionId: "conn-1",
    connectionName: "Postgres",
    databaseType: "postgres",
    database: "app",
    currentSql: "",
    tables: [],
    truncated: false,
    ...overrides,
  };
}

describe("AI SQL dialect prompt", () => {
  it("pins identifier quoting to the active database type", () => {
    const prompt = buildSystemPrompt("generate", context(), "ask");

    expect(prompt).toContain("Database type: postgres");
    expect(prompt).toContain("PostgreSQL/SQLite/Oracle");
    expect(prompt).toContain('double quotes "name"');
    expect(prompt).toContain("Do not switch dialects merely because the user mentions another database in prose.");
  });
});
