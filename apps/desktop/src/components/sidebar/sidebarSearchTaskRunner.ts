export type SidebarSearchTask = () => Promise<void>;

export const SIDEBAR_SEARCH_TASK_CONCURRENCY = 4;

export async function runSidebarSearchTasks(tasks: readonly SidebarSearchTask[], concurrency = SIDEBAR_SEARCH_TASK_CONCURRENCY): Promise<void> {
  if (tasks.length === 0) return;
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  let nextTaskIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < tasks.length) {
      const task = tasks[nextTaskIndex++];
      try {
        await task();
      } catch {}
    }
  });
  await Promise.all(workers);
}
