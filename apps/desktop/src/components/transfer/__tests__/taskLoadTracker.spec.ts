import { describe, expect, it } from "vitest";
import { createTaskLoadTracker } from "@/components/transfer/taskLoadTracker";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("taskLoadTracker", () => {
  it("keeps task B active when task A resolves after it", async () => {
    const tracker = createTaskLoadTracker();
    const taskAGate = deferred();
    const taskBGate = deferred();
    const applied: string[] = [];
    let activeTaskId: string | null = "task-a";
    const taskAToken = tracker.begin("task-a");
    const taskALoad = (async () => {
      await taskAGate.promise;
      if (tracker.isCurrent(taskAToken, activeTaskId)) applied.push("task-a");
    })();

    activeTaskId = "task-b";
    const taskBToken = tracker.begin("task-b");
    const taskBLoad = (async () => {
      await taskBGate.promise;
      if (tracker.isCurrent(taskBToken, activeTaskId)) applied.push("task-b");
    })();

    taskBGate.resolve();
    await taskBLoad;
    taskAGate.resolve();
    await taskALoad;

    expect(applied).toEqual(["task-b"]);
  });
});
