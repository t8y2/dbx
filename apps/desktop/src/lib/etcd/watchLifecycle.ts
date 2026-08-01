export type EtcdWatchStop = (connectionId: string, watchId: string) => Promise<unknown>;

export async function releaseEtcdWatch(connectionId: string, watchId: string, stop: EtcdWatchStop): Promise<void> {
  if (!watchId) return;
  await stop(connectionId, watchId);
}

export async function releaseEtcdWatchBestEffort(connectionId: string, watchId: string, stop: EtcdWatchStop): Promise<void> {
  await releaseEtcdWatch(connectionId, watchId, stop).catch(() => undefined);
}

export async function releaseEtcdWatchesBestEffort(connectionId: string, watchIds: Iterable<string>, stop: EtcdWatchStop): Promise<void> {
  await Promise.all([...watchIds].filter(Boolean).map((watchId) => releaseEtcdWatchBestEffort(connectionId, watchId, stop)));
}

export async function replaceEtcdWatch<T>(connectionId: string, previousWatchId: string, stop: EtcdWatchStop, start: () => Promise<T>): Promise<T> {
  await releaseEtcdWatch(connectionId, previousWatchId, stop);
  return start();
}
