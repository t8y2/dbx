export function createQueryEditorExecutionViewportOwnership() {
  let nextRequestId = 0;
  let pendingRequestId: number | undefined;
  let acceptedRequestId: number | undefined;

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
    consumeAcceptedRequest(): boolean {
      if (acceptedRequestId === undefined) return false;
      acceptedRequestId = undefined;
      return true;
    },
    reset() {
      pendingRequestId = undefined;
      acceptedRequestId = undefined;
    },
  };
}
