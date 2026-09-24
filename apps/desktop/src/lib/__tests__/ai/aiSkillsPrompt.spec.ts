import { beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, type AiContext, type CustomPromptContext } from "@/lib/ai/ai";
import { setLocale } from "@/i18n";
import type { ReadUserSkill } from "@/types/userSkills";

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionId: "conn-1",
    connectionName: "Postgres",
    databaseType: "postgres",
    database: "app",
    currentSql: "",
    tables: [],
    sqlFiles: [],
    csvFiles: [],
    truncated: false,
    ...overrides,
  };
}

const skill: ReadUserSkill = {
  id: "d-abc123",
  name: "SQL Review",
  description: "Team SQL review rules",
  content: "Always prefix reviews with EXPLAIN checks.",
};

// buildSystemPrompt picks zh/en copy via currentLocale(); pin to en so the
// English-string assertions are deterministic regardless of the host OS locale.
beforeAll(async () => {
  await setLocale("en");
});

describe("selected skills prompt injection", () => {
  it("injects selected skills into the SQL, Redis, and vector branches", () => {
    for (const ctx of [context(), context({ databaseType: "redis", connectionName: "Redis", database: "8" }), context({ databaseType: "qdrant", connectionName: "Qdrant", database: "vec" })]) {
      const prompt = buildSystemPrompt("general", ctx, "ask", { selectedSkills: [skill] });
      expect(prompt).toContain("## Selected Skills (supplementary)");
      expect(prompt).toContain("### Skill: SQL Review");
      expect(prompt).toContain('<ai-skill id="d-abc123">');
      expect(prompt).toContain("Always prefix reviews with EXPLAIN checks.");
      expect(prompt).toContain("</ai-skill>");
    }
  });

  it("injects the zh header for zh locale", async () => {
    await setLocale("zh-CN");
    try {
      const prompt = buildSystemPrompt("general", context(), "ask", { selectedSkills: [skill] });
      expect(prompt).toContain("## 用户选择的 Skills（补充性）");
      expect(prompt).toContain("按原样注入");
    } finally {
      await setLocale("en");
    }
  });

  it("leaves prompts byte-for-byte unchanged when no skills are selected", () => {
    // AC: with no selected skills, every prompt branch is byte-identical to the
    // pre-feature baseline. Absent field, empty array, and undefined custom all
    // must agree exactly.
    const baseline = buildSystemPrompt("general", context(), "ask");
    const withGlobals: CustomPromptContext = { globalInstructions: "Global rule." };
    const withEmptySkills: CustomPromptContext = { globalInstructions: "Global rule.", selectedSkills: [] };
    for (const ctx of [context(), context({ databaseType: "redis", connectionName: "Redis", database: "8" }), context({ databaseType: "milvus", connectionName: "Milvus", database: "vec" })]) {
      expect(buildSystemPrompt("general", ctx, "ask")).toBe(buildSystemPrompt("general", ctx, "ask", undefined));
      expect(buildSystemPrompt("general", ctx, "ask", withEmptySkills)).toBe(buildSystemPrompt("general", ctx, "ask", withGlobals));
      expect(buildSystemPrompt("general", ctx, "ask", withEmptySkills)).not.toBe(baseline); // globals still apply
    }
  });

  it("treats blank-content skills as absent", () => {
    const blank: ReadUserSkill = { ...skill, content: "   " };
    const withBlank = buildSystemPrompt("general", context(), "ask", { selectedSkills: [blank] });
    expect(withBlank).toBe(buildSystemPrompt("general", context(), "ask"));
    expect(withBlank).not.toContain("ai-skill");
  });
});
