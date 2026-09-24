import { formatAiTableMention, type AiTableMention } from "@/lib/ai/aiTableMentions";
import type { QueryEditorTableReferenceDropDetail, QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";

/** Selector marking the AI assistant panel root as a table-reference drop target. */
export const AI_ASSISTANT_TABLE_DROP_ROOT_SELECTOR = "[data-ai-assistant-root]";

export interface AiTableReferenceDropHandlerOptions {
  assistantRoot: Element | null | undefined;
  elementFromPoint: (x: number, y: number) => Element | null;
  onMention: (mention: AiTableMention, payload: QueryEditorTableReferencePayload) => void;
}

/**
 * Maps a sidebar table-reference drag payload to an AI table mention chip.
 * Only plain table/view references become mentions; database and column
 * references are not representable as table mentions and return null.
 *
 * The payload's connection/database are deliberately NOT matched against a
 * fixed composer context. That rejection was the right answer while the panel's
 * connection was whatever editor tab was active — there was nothing to retarget,
 * so a foreign table had to be dropped. Now the conversation owns its binding
 * (#9902), so a table dragged in from elsewhere *retargets the conversation*
 * (see `applyExternalBinding`), which is both what the drag means and what makes
 * the mention resolvable. A caller that wants to refuse a foreign table must
 * decide that after this function returns.
 */
export function aiTableMentionFromTableReference(payload: QueryEditorTableReferencePayload | null | undefined): AiTableMention | null {
  if (!payload || payload.referenceType === "database" || payload.columnName) return null;
  const table = payload.tableName;
  if (!table) return null;
  const schema = payload.schema;
  return { raw: formatAiTableMention(schema, table), schema, table };
}

export function handleAiTableReferenceDropEvent(event: Event, options: AiTableReferenceDropHandlerOptions): boolean {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as QueryEditorTableReferenceDropDetail | undefined;
  if (!detail?.payload) return false;
  const target = options.elementFromPoint(detail.clientX, detail.clientY);
  if (!target || !options.assistantRoot?.contains(target)) return false;
  const mention = aiTableMentionFromTableReference(detail.payload);
  if (!mention) return false;
  options.onMention(mention, detail.payload);
  return true;
}
