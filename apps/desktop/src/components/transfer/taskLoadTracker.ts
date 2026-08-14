export interface TaskLoadToken {
  generation: number;
  taskId: string;
}

export function createTaskLoadTracker() {
  let generation = 0;

  return {
    begin(taskId: string): TaskLoadToken {
      generation += 1;
      return { generation, taskId };
    },
    cancel() {
      generation += 1;
    },
    isCurrent(token: TaskLoadToken, activeTaskId: string | null) {
      return token.generation === generation && token.taskId === activeTaskId;
    },
  };
}
