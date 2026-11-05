import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/cancel-superseded-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const script = workflow.split("          script: |\n")[1].replace(/^            /gm, "");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", script);
const repo = { owner: "upstream", repo: "dbx" };
const pull = {
  number: 42,
  state: "open",
  created_at: "2026-10-01T00:00:00Z",
  base: { ref: "main", repo: { id: 1 } },
  head: { ref: "fix/ci", sha: "new", repo: { id: 2, owner: { login: "contributor" } } },
};

function run(overrides = {}) {
  return {
    id: 100,
    workflow_id: 10,
    event: "pull_request",
    head_branch: "fix/ci",
    head_repository: { id: 2 },
    head_sha: "old",
    status: "pending",
    created_at: "2026-10-02T00:00:00Z",
    pull_requests: [],
    ...overrides,
  };
}

async function invoke({ pages = [[run()]], pulls = [pull], history = [[pull]], historyError, cancelError, completed = true, readError } = {}) {
  const cancelled = [];
  let reads = 0;
  let listed = false;
  const actions = {
    getWorkflow: async (args) => {
      assert.deepEqual(args, { ...repo, workflow_id: "ci.yml" });
      return { data: { id: 10 } };
    },
    listWorkflowRuns() {},
    cancelWorkflowRun: async (args) => {
      assert.equal(listed, true);
      assert.deepEqual({ owner: args.owner, repo: args.repo }, repo);
      cancelled.push(args.run_id);
      if (cancelError) throw cancelError;
    },
    getWorkflowRun: async () => {
      if (readError) throw readError;
      return { data: { status: completed ? "completed" : "in_progress" } };
    },
  };
  const listPulls = () => {};
  const github = {
    rest: {
      actions,
      pulls: {
        list: listPulls,
        get: async (args) => {
          assert.deepEqual(args, { ...repo, pull_number: pull.number });
          return { data: structuredClone(pulls[Math.min(reads++, pulls.length - 1)]) };
        },
      },
    },
    paginate: async (method, args) => {
      if (method === listPulls) {
        assert.deepEqual(args, { ...repo, state: "all", head: "contributor:fix/ci", per_page: 100 });
        if (historyError) throw historyError;
        return history.flat();
      }
      assert.equal(method, actions.listWorkflowRuns);
      assert.deepEqual(args, { ...repo, workflow_id: 10, event: "pull_request", branch: "fix/ci", per_page: 100 });
      listed = true;
      return pages.flat();
    },
  };
  await execute(github, { repo, payload: { repository: { id: 1 }, pull_request: structuredClone(pull) } }, { info() {} });
  return { cancelled, reads, listed };
}

test("cancels old active CI runs from all pages, including fork runs without PR metadata", async () => {
  const pages = [
    [run(), run({ id: 101, status: "in_progress", pull_requests: [{ number: 42 }] })],
    [run({ id: 102, status: "queued" }), run({ id: 103, head_sha: "new" })],
    [run({ id: 104, status: "waiting" }), run({ id: 105, status: "requested" })],
  ];
  assert.deepEqual((await invoke({ pages })).cancelled, [100, 101, 102, 104, 105]);
});

test("preserves other PRs, workflows, repositories, branches, completed runs and the latest commit", async () => {
  const variants = [
    { pull_requests: [{ number: 44 }] },
    { workflow_id: 11 },
    { event: "push" },
    { head_repository: { id: 3 } },
    { head_repository: null },
    { head_branch: "another-pr" },
    { status: "completed" },
    { head_sha: "new" },
    { head_sha: undefined },
    { status: undefined },
    { pull_requests: undefined },
  ];
  assert.deepEqual((await invoke({ pages: [variants.map((value, index) => run({ id: index, ...value }))] })).cancelled, []);
});

test("does not infer run ownership when an older PR is reopened after its branch was reused", async () => {
  const other = { ...pull, number: 44, state: "closed", created_at: "2026-10-02T00:00:00Z", base: { ...pull.base, ref: "release" } };
  const history = [[pull], [other]];
  assert.deepEqual((await invoke({ history })).cancelled, []);
  assert.deepEqual((await invoke({ history, pages: [[run({ pull_requests: [{ number: 42 }] })]] })).cancelled, [100]);
});

test("branch uniqueness is scoped to the source repository and fails closed on missing identity", async () => {
  const otherRepo = { ...pull, number: 44, head: { ...pull.head, repo: { id: 3 } } };
  assert.deepEqual((await invoke({ history: [[pull, otherRepo]] })).cancelled, [100]);
  const unknownRepo = { ...otherRepo, head: { ...pull.head, repo: null } };
  assert.deepEqual((await invoke({ history: [[pull, unknownRepo]] })).cancelled, []);
  assert.deepEqual((await invoke({ history: [[]] })).cancelled, []);
  await assert.rejects(invoke({ historyError: new Error("history unavailable") }), /history unavailable/);
});

test("ignores stale events and PRs whose current identity or state has changed", async () => {
  const variants = [
    { state: "closed" },
    { head: { ...pull.head, sha: "newer" } },
    { head: { ...pull.head, ref: "renamed" } },
    { head: { ...pull.head, repo: { id: 3 } } },
    { head: { ...pull.head, repo: null } },
    { base: { ...pull.base, ref: "release" } },
    { base: { ...pull.base, repo: { id: 4 } } },
  ];
  for (const value of variants) {
    const result = await invoke({ pulls: [{ ...pull, ...value }] });
    assert.deepEqual(result.cancelled, []);
    assert.equal(result.listed, false);
  }
});

test("stops before cancellation if another commit arrives while listing runs", async () => {
  const newer = { ...pull, head: { ...pull.head, sha: "newer" } };
  assert.deepEqual((await invoke({ pulls: [pull, newer], pages: [[run(), run({ id: 101, head_sha: "newer" })]] })).cancelled, []);
});

test("rechecks the PR before every cancellation", async () => {
  const newer = { ...pull, head: { ...pull.head, sha: "newer" } };
  assert.deepEqual((await invoke({ pulls: [pull, pull, newer], pages: [[run(), run({ id: 101 })]] })).cancelled, [100]);
});

test("accepts a cancel conflict only when the run has finished", async () => {
  const conflict = Object.assign(new Error("conflict"), { status: 409 });
  assert.deepEqual((await invoke({ cancelError: conflict })).cancelled, [100]);
  await assert.rejects(invoke({ cancelError: conflict, completed: false }), /conflict/);
  await assert.rejects(invoke({ cancelError: conflict, readError: new Error("read failed") }), /read failed/);
  await assert.rejects(invoke({ cancelError: Object.assign(new Error("forbidden"), { status: 403 }) }), /forbidden/);
});

test("the privileged workflow only handles main PR synchronization and never executes PR code", () => {
  assert.match(workflow, /pull_request_target:\n    types: \[synchronize\]\n    branches: \[main\]/);
  assert.match(workflow, /permissions:\n  actions: write\n  pull-requests: read\n/);
  assert.doesNotMatch(workflow, /actions\/checkout|\brun:|secrets\.|workflow_run:|force-cancel|forceCancelWorkflowRun|\$\{\{/);
  assert.equal((workflow.match(/uses:/g) ?? []).length, 1);
});
