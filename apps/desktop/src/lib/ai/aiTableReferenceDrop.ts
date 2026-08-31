import { formatAiTableMention, type AiTableMention } from "@/lib/ai/aiTableMentions";
import type { QueryEditorTableReferenceDropDetail, QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";

/** Selector marking the AI assistant panel root as a table-reference drop target. */
export const AI_ASSISTANT_TABLE_DROP_ROOT_SELECTOR = "[data-ai-assistant-root]";

export interface AiTableReferenceDropContext {
  connectionId?: string;
  database?: string;
}

export interface AiTableReferenceDropHandlerOptions {
  context: AiTableReferenceDropContext;
  assistantRoot: Element | null | undefined;
  elementFromPoint: (x: number, y: number) => Element | null;
  onMention: (mention: AiTableMention, payload: QueryEditorTableReferencePayload) => void;
}

/**
 * Maps a sidebar table-reference drag payload to an AI table mention chip.
 * Only plain table/view references become mentions; database and column
 * references are not representable as table mentions and return null.
 */
export function aiTableMentionFromTableReference(payload: QueryEditorTableReferencePayload | null | undefined, context: AiTableReferenceDropContext): AiTableMention | null {
  if (!payload || payload.referenceType === "database" || payload.columnName) return null;
  if (!context.connectionId || context.database == null || payload.connectionId !== context.connectionId || payload.database !== context.database) return null;
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
  const mention = aiTableMentionFromTableReference(detail.payload, options.context);
  if (!mention) return false;
  options.onMention(mention, detail.payload);
  return true;
}
