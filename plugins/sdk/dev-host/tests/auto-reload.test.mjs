import test from "node:test";
import assert from "node:assert/strict";
import { AutoReload } from "../auto-reload.mjs";

test("auto reload defaults off, coalesces edits and queues edits during builds", async () => {
  let calls = 0,
    release;
  const scheduler = new AutoReload(async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
  }, 10000);
  scheduler.changed();
  await scheduler.flush();
  assert.equal(calls, 0);
  scheduler.enable(true);
  scheduler.changed();
  scheduler.changed();
  const first = scheduler.flush();
  assert.equal(calls, 1);
  scheduler.changed();
  await scheduler.flush();
  assert.equal(calls, 1);
  release();
  await first;
  const second = scheduler.flush();
  assert.equal(calls, 2);
  release();
  await second;
  scheduler.changed();
  scheduler.enable(false);
  await scheduler.flush();
  assert.equal(calls, 2);
});
