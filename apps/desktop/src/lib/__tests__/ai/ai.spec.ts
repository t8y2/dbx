import { beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, type AiContext } from "@/lib/ai/ai";
import { setLocale } from "@/i18n";

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionId: "conn-1",
    connectionName: "Postgres",
    databaseType: "postgres",
    database: "app",
    currentSql: "",
    tables: [],
    sqlFiles: [],
    truncated: false,
    ...overrides,
  };
}

describe("AI SQL dialect prompt", () => {
  // buildSystemPrompt picks zh/en copy via currentLocale(); pin to en so the
  // English-string assertions are deterministic regardless of the host OS locale.
  beforeAll(async () => {
    await setLocale("en");
  });

  it("pins identifier quoting to the active database type", () => {
    const prompt = buildSystemPrompt("generate", context(), "ask");

    expect(prompt).toContain("Database type: postgres");
    expect(prompt).toContain("PostgreSQL/SQLite/Oracle");
    expect(prompt).toContain('double quotes "name"');
    expect(prompt).toContain("Do not switch dialects merely because the user mentions another database in prose.");
  });

  it("agent mode instructs to ask for write confirmation instead of blocking", () => {
    const prompt = buildSystemPrompt("general", context(), "agent");

    expect(prompt).not.toContain("explain why it is blocked");
    expect(prompt).toContain("ask for explicit confirmation");
    expect(prompt).toContain("Never execute writes without confirmation");
  });

  it("agent mode zh instructs to ask for write confirmation instead of blocking", async () => {
    await setLocale("zh-CN");
    const prompt = buildSystemPrompt("general", context(), "agent");

    expect(prompt).not.toContain("不要执行");
    expect(prompt).toContain("明确询问用户是否确认执行");
    expect(prompt).toContain("禁止不经确认直接执行写入");
    await setLocale("en");
  });

  it("ask mode does not include agent write-confirmation prompt", () => {
    const prompt = buildSystemPrompt("general", context(), "ask");

    expect(prompt).not.toContain("ask for explicit confirmation");
    expect(prompt).not.toContain("Never execute writes without confirmation");
    expect(prompt).toContain("Ask mode");
  });

  it("MongoDB agent mode uses shell commands instead of SQL", () => {
    const prompt = buildSystemPrompt("general", context({ databaseType: "mongodb", connectionName: "MongoDB", database: "benchmark" }), "agent");

    expect(prompt).toContain("MongoDB Agent mode");
    expect(prompt).toContain("execute_query accepts MongoDB shell-style commands, not SQL");
    expect(prompt).toContain("db.collection.findOne({})");
    expect(prompt).not.toContain("get_sample_data");
  });
});
