import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseCi } from "./validate-release-ci.mjs";

const sha = "a".repeat(40);
const success = { id: 1, head_sha: sha, event: "push", run_number: 1, run_attempt: 1, status: "completed", conclusion: "success" };

test("accepts the successful CI run for the release commit", () => {
  assert.equal(validateReleaseCi([{ workflow_runs: [success] }], sha), success);
});

test("rejects missing CI and success belonging to a different commit", () => {
  assert.throws(() => validateReleaseCi([{ workflow_runs: [] }], sha), /no CI run/);
  assert.throws(() => validateReleaseCi([{ workflow_runs: [success] }], "b".repeat(40)), /no CI run/);
});

test("rejects failed, cancelled, skipped, and running CI", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
    const run = { ...success, conclusion, status: conclusion ? "completed" : "in_progress" };
    assert.throws(() => validateReleaseCi([{ workflow_runs: [run] }], sha), /must complete successfully/);
  }
});

test("does not accept an earlier success when the latest run fails", () => {
  const failed = { ...success, run_number: 2, conclusion: "failure" };
  assert.throws(() => validateReleaseCi([{ workflow_runs: [success, failed] }], sha), /completed\/failure/);
});

test("reads all result pages and respects rerun attempts", () => {
  const failed = { ...success, conclusion: "failure" };
  const rerun = { ...success, run_attempt: 2 };
  assert.equal(validateReleaseCi([{ workflow_runs: [failed] }, { workflow_runs: [rerun] }], sha), rerun);
});

test("unrelated dispatches cannot satisfy or block the source CI gate", () => {
  const dispatch = { ...success, event: "workflow_dispatch", run_number: 10, status: "in_progress", conclusion: null };
  assert.equal(validateReleaseCi([{ workflow_runs: [dispatch, success] }], sha), success);
  assert.throws(() => validateReleaseCi([{ workflow_runs: [{ ...dispatch, status: "completed", conclusion: "success" }] }], sha), /no CI run/);
});
