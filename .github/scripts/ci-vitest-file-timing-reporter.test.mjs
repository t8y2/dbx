import assert from "node:assert/strict";
import test from "node:test";
import { collectFileTimings, consoleReport, markdownReport } from "./ci-vitest-file-timing-reporter.mjs";

function testModule(file, state, diagnostic) {
  return {
    relativeModuleId: file,
    state: () => state,
    diagnostic: () => ({
      environmentSetupDuration: 0,
      prepareDuration: 0,
      setupDuration: 0,
      collectDuration: 0,
      duration: 0,
      ...diagnostic,
    }),
  };
}

test("file timing reports sort total work and keep timing phases", () => {
  const rows = collectFileTimings([
    testModule("fast.spec.ts", "passed", { duration: 100 }),
    testModule("slow.spec.ts", "failed", {
      environmentSetupDuration: 20,
      prepareDuration: 30,
      setupDuration: 40,
      collectDuration: 50,
      duration: 60,
    }),
  ]);

  assert.deepEqual(rows.map(({ file, totalMs, testsMs, collectMs, setupMs }) => ({ file, totalMs, testsMs, collectMs, setupMs })), [
    { file: "slow.spec.ts", totalMs: 200, testsMs: 60, collectMs: 50, setupMs: 90 },
    { file: "fast.spec.ts", totalMs: 100, testsMs: 100, collectMs: 0, setupMs: 0 },
  ]);
  assert.match(consoleReport(rows, 1), /0\.20s  slow\.spec\.ts/);
  assert.doesNotMatch(consoleReport(rows, 1), /fast\.spec\.ts/);
  assert.match(markdownReport(rows, "1\/2"), /Vitest file timings \(1\/2\)/);
  assert.match(markdownReport(rows), /\| failed \| `slow\.spec\.ts` \|/);
});
