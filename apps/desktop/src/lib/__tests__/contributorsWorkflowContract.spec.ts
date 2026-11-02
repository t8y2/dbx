import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UPSTREAM_REPOSITORY = "t8y2/dbx";
// Normalize CRLF so line-based matching is checkout-independent.
const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/contributors.yml"), "utf8").replace(/\r\n/g, "\n");

/** The raw lines of the `update` job block: from its key line until the next job key. */
function updateJobLines(source: string): string[] {
  const jobsStart = source.indexOf("\njobs:");
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  const key = "  update:";
  const start = source.indexOf(`\n${key}\n`, jobsStart);
  expect(start, "job update exists under jobs:").toBeGreaterThanOrEqual(0);
  const lines = source.slice(start + 1).split(/\r?\n/);
  const block = [lines[0]];
  for (const line of lines.slice(1)) {
    // The next job key (same 2-space indent) ends this block; anything less
    // indented than a job key ends the jobs section entirely.
    if (/^  [A-Za-z0-9_-]+:$/.test(line)) break;
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

describe("contributors workflow contract", () => {
  it("guards the update job to the upstream repository", () => {
    const block = updateJobLines(workflow);
    const guardLine = block.find((line) => line.trim().startsWith("if:"));
    expect(guardLine, "job update has a repository guard").toBeDefined();
    expect(guardLine?.trim()).toBe(`if: github.repository == '${UPSTREAM_REPOSITORY}'`);
    // Job-level condition: the `if:` sits directly on the job, not inside a step.
    expect(guardLine, "job update guard is job-level").toMatch(/^ {4}if:/);
  });

  it("preserves the triggers, permissions, and serialization", () => {
    // Triggers: the weekly schedule and a manual dispatch.
    expect(workflow).toContain('cron: "0 18 * * 0"');
    expect(workflow).toContain("workflow_dispatch:");
    // The snapshot job pushes to the protected main branch.
    expect(workflow).toContain("contents: write");
    // Serialization so overlapping runs cannot race the same upstream ref.
    expect(workflow).toContain("group: contributors");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
