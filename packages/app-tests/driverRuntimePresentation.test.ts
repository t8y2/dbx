import assert from "node:assert/strict";
import { test } from "vitest";

import { formatRuntimeBytes, formatRuntimeCpu, formatRuntimeUptime, runtimeHealthClass, runtimeStatusDotClass, runtimeStatusClass } from "../../apps/desktop/src/lib/driverRuntimePresentation.ts";

test("formats runtime byte counts compactly", () => {
  assert.equal(formatRuntimeBytes(null), "-");
  assert.equal(formatRuntimeBytes(12_288), "12 KB");
  assert.equal(formatRuntimeBytes(2_621_440), "2.5 MB");
});

test("formats runtime CPU and uptime", () => {
  assert.equal(formatRuntimeCpu(undefined), "-");
  assert.equal(formatRuntimeCpu(1.234), "1.2%");
  assert.equal(formatRuntimeUptime(45), "45s");
  assert.equal(formatRuntimeUptime(125), "2m");
  assert.equal(formatRuntimeUptime(7_500), "2h 5m");
});

test("maps runtime state to visual classes", () => {
  assert.match(runtimeStatusClass("running"), /emerald/);
  assert.match(runtimeStatusDotClass("running"), /emerald/);
  assert.match(runtimeStatusClass("stopped"), /muted/);
  assert.match(runtimeHealthClass("warning"), /amber/);
});
