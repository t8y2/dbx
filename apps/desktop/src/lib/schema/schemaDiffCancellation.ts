interface SchemaDiffTask {
  connectionIds: readonly string[];
  controller: AbortController;
  settled: Promise<void>;
}

const tasks = new Set<SchemaDiffTask>();

export function registerSchemaDiffTask(connectionIds: readonly string[], controller: AbortController, settled: Promise<void>): void {
  const task = { connectionIds, controller, settled };
  tasks.add(task);
  void settled.then(
    () => tasks.delete(task),
    () => tasks.delete(task),
  );
}

/** Stop new metadata requests and drain issued requests before closing their pools. */
export function cancelSchemaDiffTasksForConnection(connectionId: string, reason: Error): Promise<void> | undefined {
  const matching = [...tasks].filter((task) => task.connectionIds.includes(connectionId));
  if (matching.length === 0) return undefined;
  for (const task of matching) task.controller.abort(reason);
  return Promise.allSettled(matching.map((task) => task.settled)).then(() => undefined);
}
