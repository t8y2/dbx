#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const issueNumber = process.env.ISSUE_NUMBER;
const commentBody = process.env.COMMENT_BODY || "";
const commentUser = process.env.COMMENT_USER || "";
const commentUserType = process.env.COMMENT_USER_TYPE || "";

// Only handle /claim as a standalone word
if (!/(?:^|\s)\/claim(?:\s|$)/.test(commentBody)) {
  process.exit(0);
}

// Don't let bots claim
if (commentUserType === "Bot") {
  console.log("Commenter is a bot, skipping");
  process.exit(0);
}

console.log(`/claim from @${commentUser} on #${issueNumber}`);

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function ghJson(args) {
  const out = await gh(args);
  return JSON.parse(out);
}

// Check current assignees
const assignees = await ghJson([
  "issue", "view", issueNumber,
  "--json", "assignees",
  "-q", ".assignees",
]);

if (assignees.length > 0) {
  const names = assignees.map((a) => `@${a.login}`).join(", ");
  await gh([
    "issue", "comment", issueNumber,
    "--body", `❌ @${commentUser} 这个 issue 已经有人认领了：${names}`,
  ]);
  process.exit(0);
}

// Assign
await gh(["issue", "edit", issueNumber, "--add-assignee", commentUser]);

// Confirm
await gh([
  "issue", "comment", issueNumber,
  "--body", `✅ @${commentUser} 已认领 #${issueNumber}，开始处理吧！`,
]);

console.log(`Assigned @${commentUser} to #${issueNumber}`);
