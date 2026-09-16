/**
 * Resolve which MySQL Event editor request an ObjectBrowser tab should apply.
 *
 * ObjectBrowser receives event-open intent through three independent props:
 *
 * - `eventCreateRequestId`: explicit "create a NEW event" request. It does not
 *   depend on the EVENT row existing in the object list, so it can open the
 *   MySqlEventEditor in CREATE mode even before the list is loaded.
 * - `eventName` + `eventOpenRequestId`: "open/edit THIS existing event". It
 *   requires the EVENT row to be present in the loaded object list.
 *
 * The create request takes priority over an edit request so a stale edit target
 * can never swallow a fresh "New Event" action. Callers (queryStore) keep the
 * two states mutually exclusive, but this resolver stays defensive anyway.
 */
export type InitialEventEditorDecision = { type: "create"; requestKey: string } | { type: "edit"; requestKey: string } | { type: "ignore" };

export interface InitialEventEditorRequestInput {
  /** Monotonic "New Event" request id (undefined = no create intent). */
  eventCreateRequestId?: number;
  /** Existing event name to edit (undefined = no edit intent). */
  eventName?: string;
  /** Request id that pairs with eventName for repeat open-intent. */
  eventOpenRequestId?: number;
  /** Request key already honored by this ObjectBrowser instance (dedupe). */
  openedRequestKey: string;
  /** Whether the requested event already exists in the loaded object list. */
  hasEventRow?: boolean;
  /** Object list is still loading; defer honoring any request. */
  loadingObjects?: boolean;
}

export interface EventEditorInstanceKeyInput {
  createRequestId?: number;
  openRequestId?: number;
  rowId?: string;
}

export function eventEditorInstanceKey({ createRequestId, openRequestId, rowId }: EventEditorInstanceKeyInput): string {
  const requestKey = createRequestId !== undefined ? `create:${createRequestId}` : `open:${openRequestId ?? 0}`;
  return `${requestKey}:${rowId ?? "new"}`;
}

export function resolveInitialEventEditorRequest(input: InitialEventEditorRequestInput): InitialEventEditorDecision {
  const { eventCreateRequestId, eventName, eventOpenRequestId, openedRequestKey, hasEventRow = false, loadingObjects = false } = input;

  // A "New Event" request opens the CREATE editor without needing an existing
  // EVENT row. It is deduped by its own monotonic request id so the SAME tab
  // can be asked to re-enter create mode on every click.
  if (eventCreateRequestId !== undefined) {
    const requestKey = `create:${eventCreateRequestId}`;
    if (loadingObjects || openedRequestKey === requestKey) return { type: "ignore" };
    return { type: "create", requestKey };
  }

  const name = eventName?.trim();
  if (!name) return { type: "ignore" };
  const requestKey = `${eventOpenRequestId ?? 0}:${name}`;
  if (loadingObjects || openedRequestKey === requestKey || !hasEventRow) return { type: "ignore" };
  return { type: "edit", requestKey };
}
