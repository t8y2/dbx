export interface SidebarConnectionDisconnectResult {
  succeeded: number;
  failed: number;
  firstError?: unknown;
}

export async function disconnectSidebarConnections(connectionIds: readonly string[], disconnect: (connectionId: string) => Promise<unknown>): Promise<SidebarConnectionDisconnectResult> {
  const results = await Promise.allSettled(connectionIds.map((connectionId) => disconnect(connectionId)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

  return {
    succeeded: results.length - failures.length,
    failed: failures.length,
    firstError: failures[0]?.reason,
  };
}
