import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubClient,
  detectIssueCommand,
  findEligibleMergedPullRequest,
  handleIssueCommand,
} from "./issue-commands.mjs";

const repository = "t8y2/dbx";

function issueContext(overrides = {}) {
  return {
    state: "OPEN",
    assignees: [],
    ...overrides,
  };
}

function closeContext(overrides = {}) {
  return {
    ...issueContext({ assignees: [{ login: "contributor" }] }),
    defaultBranch: "main",
    pullRequests: [],
    ...overrides,
  };
}

function recordingClient({ issue = issueContext(), close = closeContext() } = {}) {
  const calls = [];
  return {
    calls,
    getIssueContext: async () => issue,
    getIssueCloseContext: async () => close,
    addAssignee: async (issueNumber, assignee) => calls.push({ type: "add", issueNumber, assignee }),
    removeAssignee: async (issueNumber, assignee) => calls.push({ type: "remove", issueNumber, assignee }),
    commentIssue: async (issueNumber, body) => calls.push({ type: "comment", issueNumber, body }),
    closeIssue: async (issueNumber, comment) => calls.push({ type: "close", issueNumber, comment }),
  };
}

function commandOptions(commentBody, client, overrides = {}) {
  return {
    issueNumber: "123",
    commentBody,
    commentUser: "contributor",
    commentUserType: "User",
    repository,
    client,
    ...overrides,
  };
}

test("detectIssueCommand preserves claim syntax and accepts unclaim aliases", () => {
  assert.equal(detectIssueCommand("/claim"), "claim");
  assert.equal(detectIssueCommand("please /claim"), "claim");
  assert.equal(detectIssueCommand("/unclaim"), "unclaim");
  assert.equal(detectIssueCommand("/unclaimed"), "unclaim");
  assert.equal(detectIssueCommand("/close"), "close");
  assert.equal(detectIssueCommand("please /close"), null);
});

test("claim assigns an available issue and keeps the existing response", async () => {
  const client = recordingClient();
  const result = await handleIssueCommand(commandOptions("/claim", client));

  assert.equal(result.status, "claimed");
  assert.deepEqual(client.calls, [
    { type: "add", issueNumber: "123", assignee: "contributor" },
    { type: "comment", issueNumber: "123", body: "✅ @contributor 已认领 #123，开始处理吧！" },
  ]);
});

test("claim rejects an issue that already has an assignee", async () => {
  const client = recordingClient({ issue: issueContext({ assignees: [{ login: "maintainer" }] }) });
  const result = await handleIssueCommand(commandOptions("/claim", client));

  assert.equal(result.status, "already-claimed");
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].body, /@maintainer/);
});

test("unclaim only removes the commenter from the assignee list", async () => {
  const client = recordingClient({
    issue: issueContext({ assignees: [{ login: "Contributor" }, { login: "maintainer" }] }),
  });
  const result = await handleIssueCommand(commandOptions("/unclaimed", client));

  assert.equal(result.status, "unclaimed");
  assert.deepEqual(client.calls, [
    { type: "remove", issueNumber: "123", assignee: "Contributor" },
    {
      type: "comment",
      issueNumber: "123",
      body: "✅ @contributor 已取消认领 #123，其他贡献者可以继续认领。",
    },
  ]);
});

test("unclaim rejects users who are not assigned", async () => {
  const client = recordingClient({ issue: issueContext({ assignees: [{ login: "maintainer" }] }) });
  const result = await handleIssueCommand(commandOptions("/unclaim", client));

  assert.equal(result.status, "not-assignee");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].type, "comment");
});

test("findEligibleMergedPullRequest requires the assignee's merged PR on the default branch", () => {
  const eligible = {
    number: 105,
    state: "MERGED",
    baseRefName: "main",
    mergedAt: "2026-07-27T08:00:00Z",
    author: { login: "Contributor" },
    repository: { nameWithOwner: repository },
  };
  const context = closeContext({
    pullRequests: [
      { ...eligible, number: 101, state: "OPEN" },
      { ...eligible, number: 102, baseRefName: "release" },
      { ...eligible, number: 103, author: { login: "someone-else" } },
      { ...eligible, number: 104, repository: { nameWithOwner: "someone/dbx" } },
      eligible,
    ],
  });

  assert.equal(findEligibleMergedPullRequest({ context, commentUser: "contributor", repository }), eligible);
});

test("close keeps the issue open until an eligible PR is merged", async () => {
  const client = recordingClient({
    close: closeContext({
      pullRequests: [
        {
          number: 1234,
          state: "OPEN",
          baseRefName: "main",
          author: { login: "contributor" },
          repository: { nameWithOwner: repository },
        },
      ],
    }),
  });
  const result = await handleIssueCommand(commandOptions("/close", client));

  assert.equal(result.status, "no-merged-pull-request");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].type, "comment");
});

test("close succeeds after the assignee's linked PR is merged", async () => {
  const pullRequest = {
    number: 1234,
    state: "MERGED",
    baseRefName: "main",
    mergedAt: "2026-07-27T08:00:00Z",
    author: { login: "contributor" },
    repository: { nameWithOwner: repository },
  };
  const client = recordingClient({ close: closeContext({ pullRequests: [pullRequest] }) });
  const result = await handleIssueCommand(commandOptions("/close", client));

  assert.equal(result.status, "closed");
  assert.equal(result.pullRequest, pullRequest);
  assert.deepEqual(client.calls, [
    {
      type: "close",
      issueNumber: "123",
      comment: "✅ @contributor 的关联 PR #1234 已合并，关闭 #123。",
    },
  ]);
});

test("commands ignore bots and closed unclaim requests", async () => {
  const botClient = recordingClient();
  const botResult = await handleIssueCommand(
    commandOptions("/claim", botClient, { commentUserType: "Bot" }),
  );
  assert.equal(botResult.status, "ignored-bot");
  assert.deepEqual(botClient.calls, []);

  const closedClient = recordingClient({ issue: issueContext({ state: "CLOSED" }) });
  const closedResult = await handleIssueCommand(commandOptions("/unclaim", closedClient));
  assert.equal(closedResult.status, "already-closed");
  assert.deepEqual(closedClient.calls, []);
});

test("GitHub client aggregates paginated pull request cross references", async () => {
  const responses = [
    {
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          issue: {
            state: "OPEN",
            assignees: { nodes: [{ login: "contributor" }] },
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "next-page" },
              nodes: [{ source: { __typename: "PullRequest", number: 10 } }],
            },
          },
        },
      },
    },
    {
      data: {
        repository: {
          defaultBranchRef: { name: "main" },
          issue: {
            state: "OPEN",
            assignees: { nodes: [{ login: "contributor" }] },
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: "done" },
              nodes: [
                { source: { __typename: "Issue", number: 11 } },
                { source: { __typename: "PullRequest", number: 12 } },
              ],
            },
          },
        },
      },
    },
  ];
  const args = [];
  const client = createGitHubClient({
    repository,
    runGh: async (commandArgs) => {
      args.push(commandArgs);
      return JSON.stringify(responses.shift());
    },
  });

  const context = await client.getIssueCloseContext("123");
  assert.deepEqual(context.pullRequests.map(({ number }) => number), [10, 12]);
  assert.equal(args.length, 2);
  assert.equal(args[1].includes("endCursor=next-page"), true);
});
