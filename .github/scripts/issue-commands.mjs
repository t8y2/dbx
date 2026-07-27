#!/usr/bin/env node
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ISSUE_CLOSE_CONTEXT_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
      }
      issue(number: $number) {
        state
        assignees(first: 20) {
          nodes {
            login
          }
        }
        timelineItems(first: 100, after: $endCursor, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest {
                  number
                  url
                  state
                  baseRefName
                  mergedAt
                  author {
                    login
                  }
                  repository {
                    nameWithOwner
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function sameLogin(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

export function detectIssueCommand(commentBody) {
  const body = commentBody || "";
  if (/^\s*\/unclaim(?:ed)?\s*$/.test(body)) return "unclaim";
  if (/^\s*\/close\s*$/.test(body)) return "close";
  if (/(?:^|\s)\/claim(?:\s|$)/.test(body)) return "claim";
  return null;
}

export function findEligibleMergedPullRequest({ context, commentUser, repository }) {
  return context.pullRequests
    .filter(
      (pullRequest) =>
        pullRequest.state === "MERGED" &&
        pullRequest.baseRefName === context.defaultBranch &&
        pullRequest.repository?.nameWithOwner === repository &&
        sameLogin(pullRequest.author?.login, commentUser),
    )
    .sort((left, right) => (right.mergedAt || "").localeCompare(left.mergedAt || ""))[0];
}

async function handleClaim({ issueNumber, commentUser, client }) {
  const context = await client.getIssueContext(issueNumber);
  if (context.assignees.length > 0) {
    const names = context.assignees.map(({ login }) => `@${login}`).join(", ");
    await client.commentIssue(issueNumber, `❌ @${commentUser} 这个 issue 已经有人认领了：${names}`);
    return { status: "already-claimed" };
  }

  await client.addAssignee(issueNumber, commentUser);
  await client.commentIssue(issueNumber, `✅ @${commentUser} 已认领 #${issueNumber}，开始处理吧！`);
  return { status: "claimed" };
}

async function handleUnclaim({ issueNumber, commentUser, client }) {
  const context = await client.getIssueContext(issueNumber);
  if (context.state !== "OPEN") return { status: "already-closed" };

  const assignee = context.assignees.find(({ login }) => sameLogin(login, commentUser));
  if (!assignee) {
    await client.commentIssue(
      issueNumber,
      `❌ @${commentUser} 你当前没有认领 #${issueNumber}，无法使用 \`/unclaim\`。`,
    );
    return { status: "not-assignee" };
  }

  await client.removeAssignee(issueNumber, assignee.login);
  await client.commentIssue(issueNumber, `✅ @${commentUser} 已取消认领 #${issueNumber}，其他贡献者可以继续认领。`);
  return { status: "unclaimed" };
}

async function handleClose({ issueNumber, commentUser, repository, client }) {
  const context = await client.getIssueCloseContext(issueNumber);
  if (context.state !== "OPEN") return { status: "already-closed" };

  const isAssignee = context.assignees.some(({ login }) => sameLogin(login, commentUser));
  if (!isAssignee) {
    await client.commentIssue(issueNumber, `❌ @${commentUser} 只有当前 assignee 可以使用 \`/close\`。`);
    return { status: "not-assignee" };
  }

  const pullRequest = findEligibleMergedPullRequest({ context, commentUser, repository });
  if (!pullRequest) {
    await client.commentIssue(
      issueNumber,
      `❌ @${commentUser} 暂不能关闭 #${issueNumber}：未找到由你提交、已合并到 \`${context.defaultBranch}\` 且关联此 Issue 的 PR。`,
    );
    return { status: "no-merged-pull-request" };
  }

  await client.closeIssue(
    issueNumber,
    `✅ @${commentUser} 的关联 PR #${pullRequest.number} 已合并，关闭 #${issueNumber}。`,
  );
  return { status: "closed", pullRequest };
}

export async function handleIssueCommand({
  issueNumber,
  commentBody,
  commentUser,
  commentUserType,
  repository,
  client,
}) {
  const command = detectIssueCommand(commentBody);
  if (!command) return { status: "ignored" };
  if (commentUserType === "Bot") return { status: "ignored-bot" };

  if (command === "claim") return handleClaim({ issueNumber, commentUser, client });
  if (command === "unclaim") return handleUnclaim({ issueNumber, commentUser, client });
  return handleClose({ issueNumber, commentUser, repository, client });
}

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export function createGitHubClient({ repository, runGh = gh }) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

  return {
    async getIssueContext(issueNumber) {
      return JSON.parse(
        await runGh([
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          repository,
          "--json",
          "state,assignees",
        ]),
      );
    },

    async getIssueCloseContext(issueNumber) {
      let endCursor;
      let context;

      do {
        const args = [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${issueNumber}`,
          "-f",
          `query=${ISSUE_CLOSE_CONTEXT_QUERY}`,
        ];
        if (endCursor) args.push("-f", `endCursor=${endCursor}`);

        const response = JSON.parse(await runGh(args));
        const repositoryData = response.data?.repository;
        const issue = repositoryData?.issue;
        if (!repositoryData || !issue) throw new Error(`Issue #${issueNumber} was not found in ${repository}`);

        if (!context) {
          context = {
            state: issue.state,
            defaultBranch: repositoryData.defaultBranchRef?.name,
            assignees: issue.assignees.nodes,
            pullRequests: [],
          };
          if (!context.defaultBranch) throw new Error(`Default branch was not found for ${repository}`);
        }

        context.pullRequests.push(
          ...issue.timelineItems.nodes
            .map((node) => node.source)
            .filter((source) => source?.__typename === "PullRequest"),
        );

        const { hasNextPage, endCursor: nextCursor } = issue.timelineItems.pageInfo;
        endCursor = hasNextPage ? nextCursor : undefined;
      } while (endCursor);

      return context;
    },

    async addAssignee(issueNumber, assignee) {
      await runGh(["issue", "edit", String(issueNumber), "--repo", repository, "--add-assignee", assignee]);
    },

    async removeAssignee(issueNumber, assignee) {
      await runGh(["issue", "edit", String(issueNumber), "--repo", repository, "--remove-assignee", assignee]);
    },

    async commentIssue(issueNumber, body) {
      await runGh(["issue", "comment", String(issueNumber), "--repo", repository, "--body", body]);
    },

    async closeIssue(issueNumber, comment) {
      await runGh([
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        repository,
        "--reason",
        "completed",
        "--comment",
        comment,
      ]);
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const repository = process.env.GITHUB_REPOSITORY || "";
  const result = await handleIssueCommand({
    issueNumber: process.env.ISSUE_NUMBER,
    commentBody: process.env.COMMENT_BODY || "",
    commentUser: process.env.COMMENT_USER || "",
    commentUserType: process.env.COMMENT_USER_TYPE || "",
    repository,
    client: createGitHubClient({ repository }),
  });
  console.log(`Issue command result: ${result.status}`);
}
