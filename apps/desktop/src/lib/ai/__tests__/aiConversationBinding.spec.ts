import { describe, expect, it } from "vitest";
import type { AiConversation } from "@/lib/backend/tauri";
import { activeAiRunBinding, aiContextTargetFor, bindingForSnapshot, isAiRedisConsoleTarget, isBindingUnresolved, resolveConversationBinding, sameConversationBinding, type AiConversationBinding } from "@/lib/ai/aiConversationBinding";

function conversation(overrides: Partial<AiConversation> & { id: string }): AiConversation {
  return {
    title: overrides.id,
    connectionName: "",
    connectionId: "",
    database: "",
    messages: [],
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

const AMBIENT = { connectionId: "conn-visible-tab", database: "ambient_db", schema: "ambient_schema" };

describe("resolveConversationBinding", () => {
  it("uses the conversation's own binding, not the visible tab", () => {
    const binding = resolveConversationBinding(conversation({ id: "c1", connectionId: "conn-bound", database: "bound_db", schema: "bound_schema" }), null, AMBIENT);

    expect(binding).toEqual({ connectionId: "conn-bound", database: "bound_db", schema: "bound_schema" });
  });

  it("keeps an unbound conversation unbound instead of falling back to the visible tab", () => {
    // An empty id means "deliberately unbound": the stored name matched zero or
    // several saved connections, or the bound connection was deleted. Inheriting
    // the active tab here is the exact leak #9902 reports.
    const binding = resolveConversationBinding(conversation({ id: "c2", connectionName: "gone" }), null, AMBIENT);

    expect(binding.connectionId).toBe("");
    expect(binding.database).toBe("");
  });

  it("lets a draft binding chosen before the first message win over the tab", () => {
    const draft: AiConversationBinding = { connectionId: "conn-draft", database: "draft_db" };

    const binding = resolveConversationBinding(undefined, draft, AMBIENT);

    expect(binding).toEqual(draft);
  });

  it("falls back to the ambient tab only for a chat with no persisted record", () => {
    expect(resolveConversationBinding(undefined, null, AMBIENT)).toEqual({
      connectionId: "conn-visible-tab",
      database: "ambient_db",
      schema: "ambient_schema",
    });
  });

  it("tolerates an empty ambient tab", () => {
    expect(resolveConversationBinding(undefined, null, {})).toEqual({ connectionId: "", database: "", schema: undefined });
  });
});

describe("isBindingUnresolved", () => {
  it("flags only a persisted conversation with no connection", () => {
    expect(isBindingUnresolved(conversation({ id: "c1" }), { connectionId: "", database: "" })).toBe(true);
    // A brand-new chat resolves through the ambient tab, so it is never flagged.
    expect(isBindingUnresolved(undefined, { connectionId: "", database: "" })).toBe(false);
    expect(isBindingUnresolved(conversation({ id: "c1", connectionId: "conn-a" }), { connectionId: "conn-a", database: "" })).toBe(false);
  });
});

describe("bindingForSnapshot", () => {
  it("keeps an existing conversation's binding even when the fallback points elsewhere", () => {
    // Regression guard for #9902: persistence used to re-derive the connection
    // from whatever tab was active, which is how one connection leaked across
    // every conversation.
    const conversations = [conversation({ id: "c1", connectionId: "conn-a", database: "db_a" })];

    const binding = bindingForSnapshot(conversations, "c1", { connectionId: "conn-b", database: "db_b" });

    expect(binding).toEqual({ connectionId: "conn-a", database: "db_a", schema: undefined });
  });

  it("uses the fallback for a conversation that has not been saved yet", () => {
    const fallback: AiConversationBinding = { connectionId: "conn-new", database: "db_new", schema: "public" };

    expect(bindingForSnapshot([], "brand-new", fallback)).toEqual(fallback);
  });

  it("does not resurrect a binding for another conversation's id", () => {
    const conversations = [conversation({ id: "other", connectionId: "conn-a", database: "db_a" })];

    expect(bindingForSnapshot(conversations, "c1", { connectionId: "conn-b", database: "db_b" }).connectionId).toBe("conn-b");
  });
});

describe("aiContextTargetFor", () => {
  const binding: AiConversationBinding = { connectionId: "conn-a", database: "db_a" };

  it("carries the visible editor's SQL, result and focused table on the same connection", () => {
    const result = { columns: ["id"], rows: [[1]] } as never;
    const tableMeta = { tableName: "users", schema: "public", columns: [] } as never;

    const target = aiContextTargetFor(binding, { connectionId: "conn-a", database: "db_a", sql: "select 1", result, tableMeta });

    expect(target.connectionId).toBe("conn-a");
    expect(target.database).toBe("db_a");
    expect(target.sql).toBe("select 1");
    expect(target.result).toBe(result);
    expect(target.tableMeta).toBe(tableMeta);
  });

  it("drops the editor state of another database on the same connection", () => {
    // Same server, different database: still a different target. Letting this
    // through would send another database's SQL and result rows to the provider
    // as "context" for a conversation bound elsewhere.
    const target = aiContextTargetFor(binding, {
      connectionId: "conn-a",
      database: "db_b",
      sql: "select * from other_db_only_table",
      result: { columns: [], rows: [] } as never,
      tableMeta: { tableName: "other_db_only_table", columns: [] } as never,
    });

    expect(target.connectionId).toBe("conn-a");
    expect(target.database).toBe("db_a");
    expect(target.sql).toBeUndefined();
    expect(target.result).toBeUndefined();
    expect(target.tableMeta).toBeUndefined();
  });

  it("drops another connection's editor state so its SQL cannot leak into this chat", () => {
    const target = aiContextTargetFor(binding, {
      connectionId: "conn-b",
      database: "db_a",
      sql: "delete from prod_orders",
      result: { columns: [], rows: [] } as never,
      tableMeta: { tableName: "prod_orders", columns: [] } as never,
    });

    expect(target.connectionId).toBe("conn-a");
    expect(target.sql).toBeUndefined();
    expect(target.result).toBeUndefined();
    expect(target.tableMeta).toBeUndefined();
  });

  it("omits editor state when no tab is visible", () => {
    expect(aiContextTargetFor(binding, undefined)).toEqual({ connectionId: "conn-a", database: "db_a", schema: undefined });
  });
});

describe("sameConversationBinding", () => {
  it("treats a different database or schema on the same server as a different target", () => {
    const base: AiConversationBinding = { connectionId: "conn-a", database: "prod", schema: "public" };

    expect(sameConversationBinding(base, { ...base })).toBe(true);
    expect(sameConversationBinding(base, { ...base, database: "test" })).toBe(false);
    expect(sameConversationBinding(base, { ...base, schema: "private" })).toBe(false);
    expect(sameConversationBinding(base, { ...base, connectionId: "conn-b" })).toBe(false);
  });

  it("normalizes an absent database or schema to empty", () => {
    expect(sameConversationBinding({ connectionId: "c", database: "" }, { connectionId: "c" })).toBe(true);
    expect(sameConversationBinding({ connectionId: "c", database: "", schema: "" }, { connectionId: "c", database: "" })).toBe(true);
  });
});

describe("activeAiRunBinding", () => {
  const live: AiConversationBinding = { connectionId: "conn-b", database: "db_b", schema: "private" };
  const frozen: AiConversationBinding = { connectionId: "conn-a", database: "db_a", schema: "public" };
  const run = { ...frozen, status: "awaiting_write_confirmation" as const };

  it("continues an awaiting desktop confirmation on its frozen target", () => {
    expect(activeAiRunBinding(live, run, [], false)).toEqual(frozen);
    for (const status of ["preparing", "queued", "running"] as const) {
      expect(activeAiRunBinding(live, { ...run, status }, [], false)).toEqual(frozen);
    }
  });

  it("uses the current binding for an editable recovered draft or terminal run", () => {
    expect(activeAiRunBinding(live, { ...run, status: "pending_recoverable" }, [], false)).toEqual(live);
    expect(activeAiRunBinding(live, { ...run, status: "completed" }, [], false)).toEqual(live);
  });

  it("keeps a Web proposal on the assistant message's source after rebinding", () => {
    const messages = [{ role: "user" }, { role: "assistant", sourceBinding: frozen }];
    expect(activeAiRunBinding(live, undefined, messages, true)).toEqual(frozen);
    expect(activeAiRunBinding(live, undefined, messages, false)).toEqual(live);
  });
});

describe("isAiRedisConsoleTarget", () => {
  const target: AiConversationBinding = { connectionId: "redis-a", database: "1" };

  it("requires the exact Redis logical database as well as the connection", () => {
    expect(isAiRedisConsoleTarget({ mode: "redis", connectionId: "redis-a", database: "1" }, target)).toBe(true);
    expect(isAiRedisConsoleTarget({ mode: "redis", connectionId: "redis-a", database: "0" }, target)).toBe(false);
    expect(isAiRedisConsoleTarget({ mode: "redis", connectionId: "redis-b", database: "1" }, target)).toBe(false);
    expect(isAiRedisConsoleTarget({ mode: "query", connectionId: "redis-a", database: "1" }, target)).toBe(false);
  });
});
