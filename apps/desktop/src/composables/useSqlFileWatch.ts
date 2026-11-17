import { onScopeDispose, watch } from "vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

/** Native directory notifications also survive editors saving via atomic file replacement. */
export function useSqlFileWatch(paths: () => { path: string; recursive: boolean; revision?: string }[], changed: (path: string) => Promise<unknown>) {
  type Subscription = { stop?: () => Promise<void>; timer?: ReturnType<typeof setTimeout>; running: boolean; pending: boolean };
  const subscriptions = new Map<string, Subscription>();
  let disposed = false;
  const close = (item: Subscription) => {
    clearTimeout(item.timer);
    void item.stop?.().catch(() => {});
  };
  watch(
    () => paths().map(({ path, recursive, revision }) => ({ path, recursive, revision })),
    (entries) => {
      const wanted = new Map(entries.filter(({ path }) => !!path).map((entry) => [`${entry.recursive}:${normalizeExternalSqlPath(entry.path)}:${entry.revision ?? ""}`, entry]));
      for (const [key, item] of subscriptions)
        if (!wanted.has(key)) {
          subscriptions.delete(key);
          close(item);
        }
      if (!isTauriRuntime()) return;
      for (const [key, entry] of wanted) {
        if (subscriptions.has(key)) continue;
        const item: Subscription = { running: false, pending: false };
        subscriptions.set(key, item);
        const current = () => !disposed && subscriptions.get(key) === item;
        const flush = async () => {
          if (!current()) return;
          item.pending = true;
          if (item.running) return;
          item.running = true;
          try {
            while (current() && item.pending) {
              item.pending = false;
              await changed(entry.path);
            }
          } catch {
            /* Focus/manual refresh remains available if a directory is temporarily inaccessible. */
          } finally {
            item.running = false;
          }
        };
        void (async () => {
          try {
            const stop = await api.watchSqlFileFolder(entry.path, entry.recursive, () => {
              if (!current()) return;
              clearTimeout(item.timer);
              item.timer = setTimeout(() => void flush(), 250);
            });
            if (!current()) await stop();
            else item.stop = stop;
          } catch {
            /* Unsupported watchers must not prevent opening or editing files. */
            if (current()) subscriptions.delete(key);
          }
        })();
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    disposed = true;
    for (const item of subscriptions.values()) close(item);
    subscriptions.clear();
  });
}
