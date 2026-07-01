import assert from "node:assert/strict";
import { test } from "vitest";
import { MetadataTaskLimiter } from "../../apps/desktop/src/lib/metadataTaskLimiter.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("metadata task limiter caps active tasks per scope and drains queued tasks", async () => {
  const events: Array<{ event: string; active: number; queued: number; kind: string }> = [];
  const limiter = new MetadataTaskLimiter(2, (event) => events.push(event));
  const gates = [deferred<number>(), deferred<number>(), deferred<number>(), deferred<number>()];
  let active = 0;
  let maxActive = 0;

  const tasks = gates.map((gate, index) =>
    limiter.run("conn:db", `task-${index}`, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const result = await gate.promise;
      active--;
      return result;
    }),
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(
    events.filter((event) => event.event === "queued").map((event) => event.queued),
    [1, 2],
  );

  gates[0].resolve(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(maxActive, 2);

  gates[1].resolve(2);
  gates[2].resolve(3);
  gates[3].resolve(4);

  assert.deepEqual(await Promise.all(tasks), [1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test("metadata task limiter isolates independent scopes", async () => {
  const limiter = new MetadataTaskLimiter(1);
  const first = deferred<string>();
  const second = deferred<string>();
  let active = 0;

  const a = limiter.run("conn:a", "columns", async () => {
    active++;
    const result = await first.promise;
    active--;
    return result;
  });
  const b = limiter.run("conn:b", "columns", async () => {
    active++;
    const result = await second.promise;
    active--;
    return result;
  });

  assert.equal(active, 2);
  first.resolve("a");
  second.resolve("b");
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});
