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

  return {
    beginRequest(): number {
      nextRequestId += 1;
      pendingRequestId = nextRequestId;
      return nextRequestId;
    },
    cancelPendingRequest() {
      pendingRequestId = undefined;
    },
    acceptRequest(requestId: number): boolean {
      if (pendingRequestId !== requestId) return false;
      pendingRequestId = undefined;
      acceptedRequestId = requestId;
      return true;
    },
    beginExecution() {
      executionActive = true;
      userInteractedDuringExecution = false;
    },
    recordUserInteraction() {
      if (executionActive) userInteractedDuringExecution = true;
    },
    consumeCompletionPreservation(): boolean {
      const preserveViewport = acceptedRequestId !== undefined || userInteractedDuringExecution;
      acceptedRequestId = undefined;
      executionActive = false;
      userInteractedDuringExecution = false;
      return preserveViewport;
    },
    reset() {
      pendingRequestId = undefined;
      acceptedRequestId = undefined;
      executionActive = false;
      userInteractedDuringExecution = false;
    },
  };
}
