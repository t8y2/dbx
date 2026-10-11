import type { AiAction } from "@/lib/ai/ai";
import type { AiSelectionContextInput } from "@/lib/ai/aiAttachments";
import type { AiConversationBinding } from "@/lib/ai/aiConversationBinding";

/**
 * Request shape shared by every AI entry point that lives *outside* the panel
 * (#10058 R1/R3): the editor's "Send to AI", the query-result "Fix with AI"
 * button, and the object tree's "Add to AI".
 *
 * The point of one shape is that all three resolve their target through the same
 * rule (`resolveExternalSendTarget`) instead of each growing its own: a
 * trigger from namespace B either reuses a chat already on B or opens a new chat
 * bound to B — it never rewrites the binding of an existing conversation
 * (#9902), which is what made one connection global before.
 */
export interface AiExternalContextRequest {
  /**
   * Namespace of the surface that triggered the request. `null` means it could
   * not be resolved (typically the tab's connection was deleted while the SQL
   * tab stayed open): the request must then degrade to an explicitly unbound
   * chat and tell the user, never quietly keep the previous binding (R6).
   */
  target: AiConversationBinding | null;
  /** Selections taken from that surface, attached as context data (R4/R8). */
  selections?: readonly AiSelectionContextInput[];
  /** Tables the gesture referred to — the object tree's "Add to AI". */
  tableMentions?: readonly { schema?: string; table: string }[];
  /** Action to run immediately (query-result "Fix with AI"); omitted = fill the composer only. */
  action?: AiAction;
  /** Instruction text handed to `action`. */
  instruction?: string;
  /** i18n key of the toast shown when `target` could not be resolved. */
  unresolvedKey?: string;
}
