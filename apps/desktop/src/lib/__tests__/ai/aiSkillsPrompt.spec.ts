import { beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, type AiContext, type CustomPromptContext } from "@/lib/ai/ai";
import { buildSkillListing, buildSkillListingLines } from "@/lib/ai/skillListing";
import { setLocale } from "@/i18n";
import type { UserSkillMeta } from "@/types/userSkills";

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

const catalog: UserSkillMeta[] = [{ id: "d-abc123", name: "SQL Review", description: "Team SQL review rules" }];

/**
 * The SKILL.md body text this feature stopped injecting. The catalog carries no
 * body at all any more, so this can only reappear in a prompt if whole-body
 * injection is reintroduced — which is exactly what the assertions below pin.
 * Skill capability is DBX's built-in AI only: a CLI run gets neither the listing
 * nor the body.
 */
const SKILL_BODY_SENTINEL = "Always prefix reviews with EXPLAIN checks.";

// Rendered through the real formatter so the test pins the prompt/catalog
// integration rather than a hand-written copy of the listing text.
function listing(isZh = false): string[] {
  return buildSkillListingLines(buildSkillListing({ skills: catalog, selectedIds: ["d-abc123"] }), isZh);
}

// buildSystemPrompt picks zh/en copy via currentLocale(); pin to en so the
// English-string assertions are deterministic regardless of the host OS locale.
beforeAll(async () => {
  await setLocale("en");
});

describe("skill listing prompt injection", () => {
  it("injects the listing — and no body — into the SQL, Redis, and vector branches", () => {
    for (const ctx of [context(), context({ databaseType: "redis", connectionName: "Redis", database: "8" }), context({ databaseType: "qdrant", connectionName: "Qdrant", database: "vec" })]) {
      const prompt = buildSystemPrompt("general", ctx, "ask", { skillListing: listing() });
      expect(prompt).toContain("## Available Skills (loaded on demand)");
      expect(prompt).toContain("- SQL Review [default] [user-selected]: Team SQL review rules");
      expect(prompt).toContain("call the use_skill tool first");
      // The matched skill is selected, so the strong wording must be present.
      expect(prompt).toContain("were chosen explicitly by the user");
      expect(prompt).not.toContain("<ai-skill");
      expect(prompt).not.toContain(SKILL_BODY_SENTINEL);
    }
  });

  it("injects the zh listing header for zh locale", async () => {
    await setLocale("zh-CN");
    try {
      const prompt = buildSystemPrompt("general", context(), "ask", { skillListing: listing(true) });
      expect(prompt).toContain("## 可用 Skills（按需加载）");
      expect(prompt).toContain("由用户显式选择");
    } finally {
      await setLocale("en");
    }
  });

  it("keeps the custom-instructions wrapper byte-identical when a listing is added", () => {
    // The listing must sit OUTSIDE the `## Custom Instructions` wrapper: that
    // wrapper's text is shared with the templates path, so folding skills into it
    // would change the wrapper for users who never touch skills.
    const wrapper = "## Custom Instructions (supplementary)\nThe following are user-defined conventions and templates. Core safety and dialect rules above take precedence.\n\nGlobal rule.";
    const withGlobals = buildSystemPrompt("general", context(), "ask", { globalInstructions: "Global rule." });
    const withListing = buildSystemPrompt("general", context(), "ask", { globalInstructions: "Global rule.", skillListing: listing() });
    expect(withGlobals).toContain(wrapper);
    expect(withListing).toContain(wrapper);
    expect(withListing.indexOf("## Available Skills (loaded on demand)")).toBeGreaterThan(withListing.indexOf(wrapper));
  });

  it("leaves prompts byte-for-byte unchanged when nothing is listed", () => {
    // AC: with no skills selected, every prompt branch is byte-identical to the
    // pre-feature baseline. Absent field, empty array, and undefined custom all
    // must agree exactly.
    const baseline = buildSystemPrompt("general", context(), "ask");
    const withGlobals: CustomPromptContext = { globalInstructions: "Global rule." };
    const withEmptyListing: CustomPromptContext = { globalInstructions: "Global rule.", skillListing: [] };
    for (const ctx of [context(), context({ databaseType: "redis", connectionName: "Redis", database: "8" }), context({ databaseType: "milvus", connectionName: "Milvus", database: "vec" })]) {
      expect(buildSystemPrompt("general", ctx, "ask")).toBe(buildSystemPrompt("general", ctx, "ask", undefined));
      expect(buildSystemPrompt("general", ctx, "ask", withEmptyListing)).toBe(buildSystemPrompt("general", ctx, "ask", withGlobals));
      expect(buildSystemPrompt("general", ctx, "ask", withEmptyListing)).not.toBe(baseline); // globals still apply
    }
  });

  it("treats an empty listing as absent", () => {
    const withEmpty: CustomPromptContext = { skillListing: [] };
    expect(buildSystemPrompt("general", context(), "ask", withEmpty)).toBe(buildSystemPrompt("general", context(), "ask"));
    expect(buildSystemPrompt("general", context(), "ask", withEmpty)).not.toContain("Available Skills");
  });
});
