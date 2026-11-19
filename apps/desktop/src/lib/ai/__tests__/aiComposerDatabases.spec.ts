import { describe, expect, it } from "vitest";
import { resolveComposerDatabaseReset, toggleSelectedDatabase, withDatabaseSelected, type AiComposerScope } from "@/lib/ai/aiComposerDatabases";

function scope(overrides: Partial<AiComposerScope> = {}): AiComposerScope {
  return { conversationId: "conv-1", connectionId: "conn-b", namespace: "appdb", ...overrides };
}

describe("resolveComposerDatabaseReset (#12972)", () => {
  it("keeps the selection when only the schema changed", () => {
    // The namespace is the database for database-scoped engines, so a schema
    // change (PostgreSQL `public`) is not a target change.
    const reset = resolveComposerDatabaseReset(scope(), scope(), ["appdb", "other"]);
    expect(reset).toBeNull();
  });

  it("keeps the selection when the new namespace is already selected (set-as-target)", () => {
    const reset = resolveComposerDatabaseReset(scope(), scope({ namespace: "other" }), ["appdb", "other"]);
    expect(reset).toBeNull();
  });

  it("resets to the new namespace when something else moved the target", () => {
    expect(resolveComposerDatabaseReset(scope(), scope({ namespace: "other" }), ["appdb"])).toEqual(["other"]);
  });

  it("resets on a connection switch", () => {
    expect(resolveComposerDatabaseReset(scope(), scope({ connectionId: "conn-c", namespace: "postgres" }), ["appdb", "other"])).toEqual(["postgres"]);
  });

  it("resets on a conversation switch", () => {
    expect(resolveComposerDatabaseReset(scope(), scope({ conversationId: "conv-2", namespace: "other" }), ["appdb"])).toEqual(["other"]);
  });

  it("resets when a new chat is swapped for a persisted chat on the same namespace", () => {
    // The selection belongs to the chat on screen; a different conversation must
    // never inherit context databases (#9902).
    expect(resolveComposerDatabaseReset(scope({ conversationId: "" }), scope({ conversationId: "conv-1" }), ["appdb", "other"])).toEqual(["appdb"]);
  });

  it("returns an empty selection for an engine without a namespace", () => {
    expect(resolveComposerDatabaseReset(scope(), scope({ namespace: "" }), ["appdb"])).toEqual([]);
  });

  it("keeps the chosen target through a schema change (#12972)", () => {
    // Connection B is bound to the default `postgres`; the user then sets `appdb`
    // as the target and picks the `public` schema — the target must stay appdb.
    const afterTarget = withDatabaseSelected(["postgres"], "appdb");
    const beforeSchema = scope({ namespace: "postgres" });
    const targetMoved = scope({ namespace: "appdb" });
    expect(resolveComposerDatabaseReset(beforeSchema, targetMoved, afterTarget)).toBeNull();
    expect(resolveComposerDatabaseReset(targetMoved, targetMoved, afterTarget)).toBeNull();
    expect(toggleSelectedDatabase(afterTarget, "appdb", "appdb")).toBeNull();
    expect(toggleSelectedDatabase(afterTarget, "postgres", "appdb")).toEqual(["appdb"]);
  });
});

describe("toggleSelectedDatabase", () => {
  it("adds a database to the context selection", () => {
    expect(toggleSelectedDatabase(["appdb"], "other", "appdb")).toEqual(["appdb", "other"]);
  });

  it("removes a non-target database", () => {
    expect(toggleSelectedDatabase(["appdb", "other"], "other", "appdb")).toEqual(["appdb"]);
  });

  it("refuses to remove the target database", () => {
    expect(toggleSelectedDatabase(["appdb", "other"], "appdb", "appdb")).toBeNull();
  });

  it("refuses to remove the last selected database", () => {
    expect(toggleSelectedDatabase(["appdb"], "appdb", "")).toBeNull();
  });

  it("ignores an empty database", () => {
    expect(toggleSelectedDatabase(["appdb"], "", "appdb")).toBeNull();
  });
});

describe("withDatabaseSelected", () => {
  it("appends the target when it is missing", () => {
    expect(withDatabaseSelected(["other"], "appdb")).toEqual(["other", "appdb"]);
  });

  it("keeps the selection when the target is already selected", () => {
    expect(withDatabaseSelected(["appdb", "other"], "appdb")).toEqual(["appdb", "other"]);
  });
});
