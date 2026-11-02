export interface SidebarConnectionConnectResult {
  succeeded: number;
  failed: number;
  firstError?: unknown;
}

export async function connectSidebarConnections(connectionIds: readonly string[], connect: (connectionId: string) => Promise<unknown>): Promise<SidebarConnectionConnectResult> {
  const results = await Promise.allSettled(connectionIds.map((connectionId) => connect(connectionId)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

  return {
    succeeded: results.length - failures.length,
    failed: failures.length,
    firstError: failures[0]?.reason,
  };
}
