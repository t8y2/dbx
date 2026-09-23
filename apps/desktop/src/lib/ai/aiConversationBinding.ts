import type { AiConversation } from "@/lib/backend/tauri";
import type { AiContextTarget } from "@/lib/ai/ai";
import type { QueryTab } from "@/types/database";
import type { DesktopAiRunRuntime } from "@/lib/ai/desktopAiRunRegistry";

/**
 * Connection a conversation talks to (#9902).
 *
 * The binding belongs to the conversation — not to whichever editor tab happens
 * to be active — so several conversations can run against different connections
 * at once. `schema` only applies to schema-scoped engines (Postgres, Dameng).
 */
export interface AiConversationBinding {
  connectionId: string;
  database: string;
  schema?: string;
}

/** Ambient editor state, used only as the default for a chat with no binding. */
export interface AiAmbientBinding {
  connectionId?: string;
  database?: string;
  schema?: string;
}

/**
 * Binding to use for the conversation on screen.
 *
 * A persisted conversation always wins, *including* when its `connectionId` is
 * empty: that means deliberately unbound (its stored name matched zero or
 * several saved connections, or the bound connection was deleted). Falling back
 * to the ambient tab there would recreate the cross-conversation leak this
 * binding exists to prevent, so callers must surface the unbound state instead.
 *
 * Only a chat that has never been persisted — no record yet — takes `draft` (a
 * connection chosen in the composer before the first message) or, failing that,
 * the ambient tab.
 */
export function resolveConversationBinding(conversation: AiConversation | undefined, draft: AiConversationBinding | null, ambient: AiAmbientBinding): AiConversationBinding {
  if (conversation) {
    return { connectionId: conversation.connectionId, database: conversation.database, schema: conversation.schema };
  }
  if (draft) return draft;
  return { connectionId: ambient.connectionId ?? "", database: ambient.database ?? "", schema: ambient.schema };
}

/**
 * Whether the on-screen binding needs the user to pick a connection before the
 * next request can target anything. True only for a *persisted* conversation
 * with no connection: a brand-new chat resolves through the ambient tab instead.
 */
export function isBindingUnresolved(conversation: AiConversation | undefined, binding: AiConversationBinding): boolean {
  return !!conversation && !binding.connectionId;
}

/**
 * Binding to persist when snapshotting `targetConversationId`.
 *
 * An existing conversation keeps its own binding — writing a transcript must
 * never re-derive it from the active tab, which is exactly how the binding
 * became global. A chat that has not been saved yet takes `fallback`.
 */
export function bindingForSnapshot(conversations: readonly AiConversation[], targetConversationId: string, fallback: AiConversationBinding): AiConversationBinding {
  const existing = conversations.find((conversation) => conversation.id === targetConversationId);
  if (existing) {
    return { connectionId: existing.connectionId, database: existing.database, schema: existing.schema };
  }
  return fallback;
}

/**
 * Whether two bindings name the same target.
 *
 * Compares the full namespace, not just the connection: two databases (or two
 * schemas) on one server are different targets, and treating them as equal would
 * let a conversation bound to `prod` inherit the editor state of `test`
 * (#9902 follow-up).
 */
export function sameConversationBinding(a: AiConversationBinding, b: AiConversationBinding): boolean {
  return a.connectionId === b.connectionId && (a.database ?? "") === (b.database ?? "") && (a.schema ?? "") === (b.schema ?? "");
}

/** Only an executing or awaiting run owns a frozen target. An editable
 *  recovered draft and a terminal run must follow the conversation's current
 *  binding when the user sends again. */
export function activeAiRunBinding(
  conversationBinding: AiConversationBinding,
  run: Pick<DesktopAiRunRuntime, "connectionId" | "database" | "schema" | "status"> | undefined,
  messages: readonly { role: string; sourceBinding?: AiConversationBinding }[],
  foregroundActive: boolean,
): AiConversationBinding {
  if (run?.connectionId && (run.status === "preparing" || run.status === "queued" || run.status === "running" || run.status === "awaiting_write_confirmation")) {
    return { connectionId: run.connectionId, database: run.database, schema: run.schema };
  }
  if (foregroundActive) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.sourceBinding) return message.sourceBinding;
    }
  }
  return conversationBinding;
}

/** Redis's logical DB is part of the target even when two tabs share one
 *  connection. A mismatch must be refused before reaching the visible console. */
export function isAiRedisConsoleTarget(tab: Pick<QueryTab, "mode" | "connectionId" | "database">, target: AiConversationBinding): boolean {
  return tab.mode === "redis" && tab.connectionId === target.connectionId && tab.database === target.database;
}

/**
 * Context target for a request: the conversation's namespace, plus the visible
 * editor's SQL / result / focused table — but only when that tab sits on the
 * *same namespace*. Another database's editor state is not context for this
 * chat, and carrying it would leak one database's SQL and result rows into
 * another's request.
 */
export function aiContextTargetFor(binding: AiConversationBinding, visibleTab: Pick<QueryTab, "connectionId" | "database" | "schema" | "sql" | "result" | "tableMeta"> | undefined): AiContextTarget {
  const sameTarget = !!visibleTab && sameConversationBinding(binding, { connectionId: visibleTab.connectionId, database: visibleTab.database ?? "", schema: visibleTab.schema });
  return {
    connectionId: binding.connectionId,
    database: binding.database,
    schema: binding.schema,
    ...(sameTarget && visibleTab ? { sql: visibleTab.sql, result: visibleTab.result, tableMeta: visibleTab.tableMeta } : {}),
  };
}
