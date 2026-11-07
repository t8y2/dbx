export function createRelationalNavigationQueue() {
  const tasks = new Map<string, { run: () => Promise<void>; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; foreground: boolean; running: boolean }>();
  let active = 0;
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (active < 2) {
        const pending = [...tasks.entries()].filter(([, task]) => !task.running);
        const next = pending.find(([, task]) => task.foreground) ?? pending[0];
        if (!next) return;
        const [key, task] = next;
        task.running = true;
        active++;
        void Promise.resolve()
          .then(task.run)
          .then(task.resolve, task.reject)
          .finally(() => {
            tasks.delete(key);
            active--;
            schedule();
          });
      }
    });
  }
  return {
    enqueue(key: string, run: () => Promise<void>, foreground = false): Promise<void> {
      const existing = tasks.get(key);
      if (existing) {
        existing.foreground ||= foreground;
        schedule();
        return existing.promise;
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      tasks.set(key, { run, promise, resolve, reject, foreground, running: false });
      schedule();
      return promise;
    },
    cancel(matches: (key: string) => boolean) {
      for (const [key, task] of tasks) {
        if (!task.running && matches(key)) {
          tasks.delete(key);
          task.resolve();
        }
      }
    },
  };
}
