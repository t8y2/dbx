import { expect, it } from "vitest";
import { createRedisKeyViewYield } from "../redisKeyViewScheduler";
import { buildRedisKeySnapshotCooperatively } from "../redisKeyTree";

it("uses small checkpoints without paying a task/frame for every checkpoint", async () => {
  let clock = 0;
  let tasks = 0;
  const checkpoint = createRedisKeyViewYield({
    now: () => clock,
    yieldTask: async () => {
      tasks++;
    },
    budgetMs: 8,
  });
  for (let i = 0; i < 1000; i++) {
    clock += 0.125;
    await checkpoint();
  }
  expect(tasks).toBe(15);
});

it("retains builder cancellation checks before a real task is needed", async () => {
  let checks = 0;
  let tasks = 0;
  const keys = Array.from({ length: 2000 }, (_, i) => ({ key_raw: String(i), key_display: String(i), ttl: -1, key_type: "string" }));
  const result = await buildRedisKeySnapshotCooperatively(
    [keys],
    { db: 0, flatRows: true, expandAll: false, expandedGroupIds: new Set() },
    {
      workChunkSize: 512,
      shouldContinue: () => ++checks < 5,
      yieldControl: createRedisKeyViewYield({
        now: () => 0,
        yieldTask: async () => {
          tasks++;
        },
      }),
    },
  );
  expect(result).toBeNull();
  expect(tasks).toBe(0);
});
