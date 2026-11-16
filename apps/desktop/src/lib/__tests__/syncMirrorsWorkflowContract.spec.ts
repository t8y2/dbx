import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UPSTREAM_REPOSITORY = "t8y2/dbx";
// Normalize CRLF so line-based matching is checkout-independent.
const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/sync-mirrors.yml"), "utf8").replace(/\r\n/g, "\n");

/** Job ids declared under `jobs:`, in source order. */
function mirrorJobIds(source: string): string[] {
  const jobsStart = source.indexOf("\njobs:");
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  return [...source.slice(jobsStart).matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((match) => match[1]);
}

/** The raw lines of one job block: from its key line until the next job key. */
function mirrorJobLines(source: string, jobId: string): string[] {
  const jobsStart = source.indexOf("\njobs:");
  const key = `  ${jobId}:`;
  const start = source.indexOf(`\n${key}\n`, jobsStart);
  expect(start, `job ${jobId} exists under jobs:`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(start + 1).split(/\r?\n/);
  const block: string[] = [lines[0]];
  for (const line of lines.slice(1)) {
    // The next job key (same 2-space indent) ends this block; anything less
    // indented than a job key ends the jobs section entirely.
    if (/^  [A-Za-z0-9_-]+:$/.test(line)) break;
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

describe("sync-mirrors workflow contract (#10944)", () => {
  it("keeps the fixed mirror publication jobs", () => {
    expect(mirrorJobIds(workflow)).toEqual(["sync-cnb", "sync-atomgit", "sync-gitee"]);
  });

  it("guards every mirror publication job to the upstream repository", () => {
    const guard = `if: github.repository == '${UPSTREAM_REPOSITORY}'`;
    for (const jobId of mirrorJobIds(workflow)) {
      const block = mirrorJobLines(workflow, jobId);
      const guardLine = block.find((line) => line.trim().startsWith("if:"));
      expect(guardLine, `job ${jobId} has a repository guard`).toBeDefined();
      expect(guardLine?.trim()).toBe(guard);
      // Job-level condition: the `if:` sits directly on the job, not inside a step.
      expect(guardLine, `job ${jobId} guard is job-level`).toMatch(/^ {4}if:/);
    }
  });

  it("preserves the mirror triggers, serialization, and destinations", () => {
    // Triggers: tag pushes, ref deletions, scheduled runs, manual dispatch.
    expect(workflow).toContain("push:");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("delete:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    // Serialization so overlapping triggers cannot race the same upstream ref.
    expect(workflow).toContain("group: sync-mirrors");
    // Fixed destinations are unchanged.
    expect(workflow).toContain("cnb.cool/dbxio.com/dbx.git");
    expect(workflow).toContain("atomgit.com/t8y2/dbx.git");
    expect(workflow).toContain("gitee.com/codetty/dbx.git");
  });
});
