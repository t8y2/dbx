import assert from "node:assert/strict";
import { test } from "vitest";

import {
  addDriverInstallQueue,
  driverInstallProgressPercent,
  isDriverInstallCanceledError,
  isDriverInstallCancellationTarget,
  isDriverInstallProgressTarget,
  removeDriverInstallQueue,
  requestAgentInstallCancellation,
  resolveAgentInstallOutcome,
  takeNextDriverInstallQueue,
} from "../../apps/desktop/src/lib/connection/driverInstallProgressUi.ts";

test("formats driver install progress as a bounded whole percent", () => {
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 3_900_000, total: 10_500_000 }), 37);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: -1, total: 10 }), 0);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 11, total: 10 }), 100);
});

test("returns null when install progress has no measurable total", () => {
  assert.equal(driverInstallProgressPercent(null), null);
  assert.equal(driverInstallProgressPercent({ step: "jre-extract" }), null);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 1, total: 0 }), null);
});

test("targets only the row currently installing or upgrading", () => {
  assert.equal(isDriverInstallProgressTarget("mysql", { installing: "mysql", upgradingAll: false, progressMap: {} }), true);
  assert.equal(isDriverInstallProgressTarget("postgres", { installing: "mysql", upgradingAll: false, progressMap: {} }), false);
  assert.equal(
    isDriverInstallProgressTarget("postgres", {
      installing: null,
      upgradingAll: true,
      progressMap: { postgres: { step: "driver", db_type: "postgres", downloaded: 1, total: 2 } },
    }),
    true,
  );
});

test("shows single-driver cancel only after the cancellable agent operation starts", () => {
  assert.equal(
    isDriverInstallCancellationTarget("mysql", {
      activeOperationId: null,
      cancellableDbType: null,
      upgradingAll: false,
      progressMap: {},
    }),
    false,
  );
  assert.equal(
    isDriverInstallCancellationTarget("mysql", {
      activeOperationId: "operation-a",
      cancellableDbType: "mysql",
      upgradingAll: false,
      progressMap: {},
    }),
    true,
  );
  assert.equal(
    isDriverInstallCancellationTarget("postgres", {
      activeOperationId: "operation-a",
      cancellableDbType: "mysql",
      upgradingAll: false,
      progressMap: {},
    }),
    false,
  );
});

test("keeps batch row cancellation scoped to registered progress entries", () => {
  assert.equal(
    isDriverInstallCancellationTarget("postgres", {
      activeOperationId: "batch-a",
      cancellableDbType: null,
      upgradingAll: true,
      progressMap: { postgres: { step: "driver", db_type: "postgres" } },
    }),
    true,
  );
  assert.equal(
    isDriverInstallCancellationTarget("mysql", {
      activeOperationId: "batch-a",
      cancellableDbType: null,
      upgradingAll: true,
      progressMap: { postgres: { step: "driver", db_type: "postgres" } },
    }),
    false,
  );
});

test("adds queued driver installs without duplicating the active or queued driver", () => {
  assert.deepEqual(addDriverInstallQueue(["postgres"], "mysql", "sqlite"), ["postgres", "mysql"]);
  assert.deepEqual(addDriverInstallQueue(["postgres"], "postgres", "sqlite"), ["postgres"]);
  assert.deepEqual(addDriverInstallQueue(["postgres"], "sqlite", "sqlite"), ["postgres"]);
});

test("removes queued driver installs", () => {
  assert.deepEqual(removeDriverInstallQueue(["postgres", "mysql", "sqlite"], "mysql"), ["postgres", "sqlite"]);
});

test("takes the next installable queued driver and drops stale queued drivers", () => {
  const result = takeNextDriverInstallQueue(["installed", "mysql", "sqlite"], (dbType) => dbType !== "installed");

  assert.equal(result.next, "mysql");
  assert.deepEqual(result.queue, ["sqlite"]);
});

test("recognizes a user-cancelled driver install error", () => {
  assert.equal(isDriverInstallCanceledError(new Error("Agent download canceled by user.")), true);
  assert.equal(isDriverInstallCanceledError("prefix Agent download canceled by user. suffix"), true);
  assert.equal(isDriverInstallCanceledError({ message: "Agent download canceled by user." }), true);
  assert.equal(isDriverInstallCanceledError("Failed to install driver: 404"), false);
  assert.equal(isDriverInstallCanceledError(null), false);
  assert.equal(isDriverInstallCanceledError(undefined), false);
});

test("a failed cancel request keeps the install outcome as a real failure", async () => {
  const result = await requestAgentInstallCancellation(async () => {
    throw new Error("cancel transport failed");
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("cancel request must fail");
  assert.match(String(result.error), /cancel transport failed/);
  assert.deepEqual(
    resolveAgentInstallOutcome(
      { ok: false, error: new Error("download failed") },
      {
        operationId: "operation-a",
        currentOperationId: "operation-a",
        cancelRequested: result.ok,
      },
    ),
    { kind: "failed", ownsState: true },
  );
});

test("cancel then immediate retry: the stale operation never owns the dialog state", () => {
  // The dialog flow: operation A begins, the user cancels (the cancel handler
  // finishes the dialog, clearing the tracked id), then retries - operation B
  // begins - before A's install promise settles.
  const staleContext = {
    operationId: "operation-a",
    currentOperationId: "operation-b",
    cancelRequested: false,
  };

  const cancelled = resolveAgentInstallOutcome({ ok: false, error: new Error("Agent download canceled by user.") }, staleContext);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.ownsState, false);

  const succeeded = resolveAgentInstallOutcome({ ok: true }, staleContext);
  assert.equal(succeeded.kind, "succeeded");
  assert.equal(succeeded.ownsState, false);

  const failed = resolveAgentInstallOutcome({ ok: false, error: new Error("Download failed: 404") }, staleContext);
  assert.equal(failed.kind, "failed");
  assert.equal(failed.ownsState, false);
});

test("cancel without retry: the cleared dialog is not re-failed by the old promise", () => {
  // After the cancel handler ran, no operation is tracked, so the old
  // promise's settlement must not own state either.
  const clearedContext = {
    operationId: "operation-a",
    currentOperationId: null,
    cancelRequested: true,
  };

  const cancelled = resolveAgentInstallOutcome({ ok: false, error: new Error("Download failed: 404") }, clearedContext);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.ownsState, false);
});

test("the active operation owns the dialog state on every outcome", () => {
  const context = {
    operationId: "operation-a",
    currentOperationId: "operation-a",
    cancelRequested: false,
  };

  assert.deepEqual(resolveAgentInstallOutcome({ ok: true }, context), { kind: "succeeded", ownsState: true });
  assert.deepEqual(resolveAgentInstallOutcome({ ok: false, error: new Error("Agent download canceled by user.") }, context), { kind: "cancelled", ownsState: true });
  assert.deepEqual(resolveAgentInstallOutcome({ ok: false, error: new Error("Download failed: 404") }, context), { kind: "failed", ownsState: true });
});
