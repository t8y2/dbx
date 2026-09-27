import { describe, expect, it } from "vitest";
import { runSidebarSearchTasks } from "../sidebarSearchTaskRunner";

describe("ConnectionTree global search loading", () => {
  it("limits concurrent metadata loads without dropping a task", async () => {
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    let completedTasks = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
      activeTasks += 1;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeTasks -= 1;
      completedTasks += 1;
    });

    await runSidebarSearchTasks(tasks, 2);

    expect(maximumActiveTasks).toBe(2);
    expect(completedTasks).toBe(tasks.length);
  });
});
