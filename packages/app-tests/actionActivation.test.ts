import { strict as assert } from "node:assert";
import { test } from "vitest";
import { shouldSuppressRepeatedActivation, tryStartExclusiveActivation } from "../../apps/desktop/src/lib/connection/actionActivation.ts";

test("allows the first activation", () => {
  const guard = {};

  assert.equal(shouldSuppressRepeatedActivation(guard, 1000), false);
});

test("suppresses repeated activation inside the guard window", () => {
  const guard = {};

  assert.equal(shouldSuppressRepeatedActivation(guard, 1000, 500), false);
  assert.equal(shouldSuppressRepeatedActivation(guard, 1200, 500), true);
});

test("allows activation after the guard window", () => {
  const guard = {};

  assert.equal(shouldSuppressRepeatedActivation(guard, 1000, 500), false);
  assert.equal(shouldSuppressRepeatedActivation(guard, 1600, 500), false);
});

test("exclusive activation blocks concurrent starts until finished", () => {
  const guard = {};
  const finish = tryStartExclusiveActivation(guard);

  assert.equal(typeof finish, "function");
  assert.equal(tryStartExclusiveActivation(guard), null);

  finish?.();

  assert.equal(typeof tryStartExclusiveActivation(guard), "function");
});
