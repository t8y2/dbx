const pending = new Map<string, Promise<unknown>>();

/** Share only reads from the same cache generation; never retain failed results. */
export function shareObjectBrowserRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const request = Promise.resolve().then(read);
  pending.set(key, request);
  void request
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    })
    .catch(() => undefined);
  return request;
}
