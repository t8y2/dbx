import { strict as assert } from "node:assert";
import { test } from "vitest";
import type { AiContext } from "../../apps/desktop/src/lib/ai/ai.ts";
import { promptTemplateCharacterCount, type PromptTemplate } from "../../apps/desktop/src/types/promptTemplate";

// ---------------------------------------------------------------------------
// Setup (mirrors existing aiPrompt.test.ts setup)
// ---------------------------------------------------------------------------

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const localStorage = new MemoryStorage();
localStorage.setItem("dbx-locale", "en");

Object.defineProperty(globalThis, "localStorage", {
  value: localStorage,
  configurable: true,
});

const { buildSystemPrompt, isVectorDbType } = await import("../../apps/desktop/src/lib/ai/ai.ts");

// Test via buildSystemPrompt and its public API.

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionId: "conn-1",
    connectionName: "prod-analytics",
    databaseType: "postgres",
    database: "app",
    currentSql: "",
    tables: [
      {
        schema: "public",
        name: "orders",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "uuid", is_nullable: false, is_primary_key: true },
          { name: "user_id", data_type: "uuid", is_nullable: false },
          { name: "total", data_type: "numeric", is_nullable: false },
        ],
        indexes: [{ name: "idx_orders_user_id", columns: ["user_id"], is_unique: false, is_primary: false }],
        foreignKeys: [{ column: "user_id", ref_table: "users", ref_column: "id" }],
      },
    ],
    sqlFiles: [],
    truncated: false,
    ...overrides,
  };
}

function makeTemplate(id: string, name: string, content: string): PromptTemplate {
  return { id, name, content, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

test("prompt template character count matches Rust Unicode scalar counting", () => {
  assert.strictEqual(promptTemplateCharacterCount("A😀中"), 3);
  assert.strictEqual(promptTemplateCharacterCount("😀".repeat(8000)), 8000);
});

// ---------------------------------------------------------------------------
// Baseline (no custom context) — byte-identical
// ---------------------------------------------------------------------------

test("buildSystemPrompt without custom = byte-identical baseline", () => {
  const baseline = buildSystemPrompt("general", context(), "ask");
  const withUndefined = buildSystemPrompt("general", context(), "ask", undefined);
  const withEmpty = buildSystemPrompt("general", context(), "ask", {});
  assert.strictEqual(withUndefined, baseline);
  assert.strictEqual(withEmpty, baseline);
});

test("buildSystemPrompt without custom (agent mode) = byte-identical baseline", () => {
  const baseline = buildSystemPrompt("generate", context(), "agent");
  const withUndefined = buildSystemPrompt("generate", context(), "agent", undefined);
  assert.strictEqual(withUndefined, baseline);
});

// ---------------------------------------------------------------------------
// Global instructions only
// ---------------------------------------------------------------------------

test("global instructions only — injected in relational path", () => {
  const prompt = buildSystemPrompt("general", context(), "ask", {
    globalInstructions: "Always use UTC timestamps.",
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /Always use UTC timestamps/);
  // Should NOT have template heading
  assert.doesNotMatch(prompt, /### /);
});

test("global instructions only — injected in vector path (qdrant)", () => {
  const prompt = buildSystemPrompt("general", context({ databaseType: "qdrant" }), "ask", {
    globalInstructions: "Use vector search for similarity.",
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /Use vector search for similarity/);
});

// ---------------------------------------------------------------------------
// Templates only
// ---------------------------------------------------------------------------

test("templates only — injected in relational path", () => {
  const prompt = buildSystemPrompt("general", context(), "ask", {
    activeTemplates: [
      makeTemplate("t1", "Production Rules", "Always filter by tenant_id."),
    ],
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /### Production Rules/);
  assert.match(prompt, /Always filter by tenant_id/);
});

test("templates only — injected in vector path (qdrant)", () => {
  const prompt = buildSystemPrompt("general", context({ databaseType: "qdrant" }), "ask", {
    activeTemplates: [
      makeTemplate("t1", "Vector Conventions", "Collections must have metadata."),
    ],
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /### Vector Conventions/);
  assert.match(prompt, /Collections must have metadata/);
});

// ---------------------------------------------------------------------------
// Both global instructions and templates
// ---------------------------------------------------------------------------

test("global + templates — correct order: global first, then templates", () => {
  const prompt = buildSystemPrompt("general", context(), "ask", {
    globalInstructions: "GLOBAL_RULE",
    activeTemplates: [
      makeTemplate("t1", "Template1", "T1_CONTENT"),
      makeTemplate("t2", "Template2", "T2_CONTENT"),
    ],
  });

  // Section header appears
  assert.match(prompt, /Custom Instructions \(supplementary\)/);

  // Global must appear before template sections
  const customStart = prompt.indexOf("## Custom Instructions");
  const globalPos = prompt.indexOf("GLOBAL_RULE", customStart);
  const t1Pos = prompt.indexOf("### Template1", customStart);
  const t2Pos = prompt.indexOf("### Template2", customStart);
  assert.ok(globalPos < t1Pos, "global instructions must appear before Template1");
  assert.ok(t1Pos < t2Pos, "Template1 must appear before Template2");
});

// ---------------------------------------------------------------------------
// Whitespace-only content stripped
// ---------------------------------------------------------------------------

test("whitespace-only template content not injected", () => {
  const prompt = buildSystemPrompt("general", context(), "ask", {
    activeTemplates: [
      makeTemplate("t1", "Empty Template", "   \n  \t  "),
      makeTemplate("t2", "Valid Template", "Do X and Y."),
    ],
  });
  assert.match(prompt, /### Valid Template/);
  assert.doesNotMatch(prompt, /### Empty Template/);
  assert.match(prompt, /Do X and Y/);
});

test("whitespace-only global instructions not injected", () => {
  const baseline = buildSystemPrompt("general", context(), "ask");
  const withBlankGlobal = buildSystemPrompt("general", context(), "ask", {
    globalInstructions: "   \n  \t  ",
  });
  assert.strictEqual(withBlankGlobal, baseline);
});

// ---------------------------------------------------------------------------
// Vector DB types all covered
// ---------------------------------------------------------------------------

test("vector db type (chromadb) includes injected section", () => {
  const prompt = buildSystemPrompt("general", context({ databaseType: "chromadb" }), "ask", {
    globalInstructions: "Chromadb instructions.",
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /Chromadb instructions/);
});

test("vector db type (milvus) includes injected section", () => {
  const prompt = buildSystemPrompt("general", context({ databaseType: "milvus" }), "ask", {
    activeTemplates: [makeTemplate("t1", "Milvus Rules", "Use partition key.")],
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /### Milvus Rules/);
});

// ---------------------------------------------------------------------------
// Agent mode also injects
// ---------------------------------------------------------------------------

test("agent mode injects custom instructions", () => {
  const prompt = buildSystemPrompt("query", context(), "agent", {
    globalInstructions: "AGENT_RULE",
  });
  assert.match(prompt, /Custom Instructions \(supplementary\)/);
  assert.match(prompt, /AGENT_RULE/);
});

// ---------------------------------------------------------------------------
// Empty custom context equals no custom context (byte-identical)
// ---------------------------------------------------------------------------

test("custom with all empty fields equals no custom", () => {
  const baseline = buildSystemPrompt("general", context(), "ask");
  const withEmpty = buildSystemPrompt("general", context(), "ask", {
    globalInstructions: "",
    activeTemplates: [],
  });
  assert.strictEqual(withEmpty, baseline);
});
