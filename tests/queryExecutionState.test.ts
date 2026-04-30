import { strict as assert } from "node:assert";
import test from "node:test";
import { canCancelQueryExecution, queryExecutionLabelKey } from "../src/lib/queryExecutionState.ts";

test("only allows cancelling an active execution with an execution id", () => {
  assert.equal(canCancelQueryExecution({ isExecuting: true, executionId: "exec-1" }), true);
  assert.equal(canCancelQueryExecution({ isExecuting: true, executionId: "exec-1", isCancelling: true }), false);
  assert.equal(canCancelQueryExecution({ isExecuting: true }), false);
  assert.equal(canCancelQueryExecution({ isExecuting: false, executionId: "exec-1" }), false);
});

test("uses a stopping label while cancellation is in progress", () => {
  assert.equal(queryExecutionLabelKey({ isExecuting: true }), "common.loading");
  assert.equal(queryExecutionLabelKey({ isExecuting: true, isCancelling: true }), "common.stopping");
});
