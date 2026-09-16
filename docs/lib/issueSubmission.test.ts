import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildGitHubIssueBody,
  consumeRollingLimit,
  detectIssueImageType,
  issueAiRequestTimeoutMs,
  normalizeIssueTitle,
  parseIssueAiResponse,
  validateEditableIssue,
} from "./issueSubmission";

test("rolling limits allow eight attempts and release the oldest after one hour", () => {
  let timestamps: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const result = consumeRollingLimit(timestamps, index * 1000);
    assert.equal(result.allowed, true);
    timestamps = result.timestamps;
  }

  const rejected = consumeRollingLimit(timestamps, 8_000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);

  const released = consumeRollingLimit(timestamps, 60 * 60 * 1000 + 1);
  assert.equal(released.allowed, true);
  assert.equal(released.remaining, 0);
});

test("AI JSON is extracted, typed, and normalized to the repository title prefix", () => {
  const preview = parseIssueAiResponse(`\n\`\`\`json\n{
    "type": "compatibility",
    "title": "PostgreSQL schema remains loading",
    "summary": "Schema loading does not finish.",
    "body": "## Description\\n\\nThe schema remains loading after connecting."
  }\n\`\`\``);

  assert.equal(preview.type, "compatibility");
  assert.equal(preview.title, "[Compatibility] PostgreSQL schema remains loading");
  assert.match(preview.body, /schema remains loading/);
});

test("editable drafts use server-owned labels and one canonical prefix", () => {
  assert.equal(normalizeIssueTitle("[Bug] Connection fails on startup", "feature"), "[Feature] Connection fails on startup");
  assert.deepEqual(
    validateEditableIssue({ type: "question", title: "How to configure an SSH tunnel", body: "## Goal\n\nConnect to PostgreSQL through an SSH tunnel." }).labels,
    ["question"],
  );
});

test("image validation trusts magic bytes rather than the browser MIME value", () => {
  assert.deepEqual(detectIssueImageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), {
    contentType: "image/png",
    extension: "png",
  });
  assert.equal(detectIssueImageType(new TextEncoder().encode("not an image")), null);
});

test("image drafts allow more time than text-only drafts", () => {
  assert.equal(issueAiRequestTimeoutMs(0), 45_000);
  assert.equal(issueAiRequestTimeoutMs(1), 90_000);
  assert.equal(issueAiRequestTimeoutMs(3), 90_000);
});

test("published bodies append public attachments and an anonymous-source marker", () => {
  const body = buildGitHubIssueBody("## Description\n\nLoading never finishes.", ["https://dl.dbxio.com/issue/image.png"], "en");
  assert.match(body, /## Attachments/);
  assert.match(body, /anonymous DBX website form/);
});
