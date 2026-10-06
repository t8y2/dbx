export interface QueryEditorViewportRange {
  from: number;
  to: number;
}

export function isQueryEditorPositionVisible(position: number, visibleRanges: readonly QueryEditorViewportRange[] | undefined, viewport: QueryEditorViewportRange): boolean {
  const ranges = visibleRanges && visibleRanges.length > 0 ? visibleRanges : [viewport];
  return ranges.some((range) => position >= range.from && position <= range.to);
}

export function createQueryEditorExecutionViewportOwnership() {
  let nextRequestId = 0;
  let pendingRequestId: number | undefined;
  let acceptedRequestId: number | undefined;
  let executionActive = false;
  let userInteractedDuringExecution = false;
  let cursorVisibleBeforeExecution = false;

  return {
    beginRequest(): number {
      nextRequestId += 1;
      pendingRequestId = nextRequestId;
      return nextRequestId;
    },
    cancelPendingRequest(requestId?: number): boolean {
      if (requestId !== undefined && pendingRequestId !== requestId) return false;
      if (pendingRequestId === undefined) return false;
      pendingRequestId = undefined;
      return true;
    },
    acceptRequest(requestId: number): boolean {
      if (pendingRequestId !== requestId) return false;
      pendingRequestId = undefined;
      acceptedRequestId = requestId;
      return true;
    },
    // Captured while the editor viewport still has its pre-execution size: once
    // the results pane opens it shrinks the editor, and a cursor that was
    // comfortably visible before then can fall outside the smaller viewport,
    // which must not be read as "the user cannot see their cursor" (#10480).
    beginExecution(cursorVisible = false) {
      executionActive = true;
      userInteractedDuringExecution = false;
      cursorVisibleBeforeExecution = cursorVisible;
    },
    recordUserInteraction() {
      if (executionActive) userInteractedDuringExecution = true;
    },
    consumeCompletionPreservation(): boolean {
      const preserveViewport = acceptedRequestId !== undefined || userInteractedDuringExecution || cursorVisibleBeforeExecution;
      acceptedRequestId = undefined;
      executionActive = false;
      userInteractedDuringExecution = false;
      cursorVisibleBeforeExecution = false;
      return preserveViewport;
    },
    reset() {
      pendingRequestId = undefined;
      acceptedRequestId = undefined;
      executionActive = false;
      userInteractedDuringExecution = false;
      cursorVisibleBeforeExecution = false;
    },
  };
}
