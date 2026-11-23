import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UPSTREAM_REPOSITORY = "t8y2/dbx";
const GUARD = `github.repository == '${UPSTREAM_REPOSITORY}'`;

/** Read a workflow file with CRLF normalized so line-based matching is checkout-independent. */
function readWorkflow(name: string): string {
  return readFileSync(resolve(process.cwd(), `.github/workflows/${name}`), "utf8").replace(/\r\n/g, "\n");
}

/**
 * The raw lines of one job block: from its key line until the next job key.
 */
function jobLines(source: string, jobId: string): string[] {
  const jobsStart = source.indexOf("\njobs:");
  expect(jobsStart).toBeGreaterThanOrEqual(0);
  const key = `  ${jobId}:`;
  const start = source.indexOf(`\n${key}\n`, jobsStart);
  expect(start, `job ${jobId} exists under jobs:`).toBeGreaterThanOrEqual(0);
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

/**
 * The job-level `if:` lines of a job block. A job-level condition is a single
 * line indented 4 spaces; a step-level condition is nested deeper, so matching
 * on the indentation keeps the two apart instead of counting both.
 */
function jobGuardLines(source: string, jobId: string): string[] {
  return jobLines(source, jobId).filter((line) => /^ {4}if:/.test(line));
}

/**
 * Each of these workflows depends on upstream-only repository secrets, so every
 * fork fails them and mails the fork owner a failure notification on every run.
 * The guard keeps them running upstream only, where the secrets exist.
 */
const GUARDED_JOBS = [
  { file: "daily-beta-release.yml", jobId: "create-beta" },
  { file: "dockerhub-description.yml", jobId: "update" },
  { file: "update-nix-pnpm-hash.yml", jobId: "update" },
];

describe("fork-aware workflow contract", () => {
  for (const { file, jobId } of GUARDED_JOBS) {
    it(`guards ${file} (${jobId}) to the upstream repository`, () => {
      const workflow = readWorkflow(file);
      const guardLines = jobGuardLines(workflow, jobId);
      expect(guardLines, `job ${jobId} has a repository guard`).toHaveLength(1);
      expect(guardLines[0]?.trim()).toBe(`if: ${GUARD}`);
      // Job-level condition: the `if:` sits directly on the job, not inside a step.
      expect(guardLines[0], `job ${jobId} guard is job-level`).toMatch(/^ {4}if:/);
    });
  }

  it("guards the docs build job to the upstream repository", () => {
    const workflow = readWorkflow("docs.yml");
    const guardLines = jobGuardLines(workflow, "build");
    // A job-level `if:` is a single line, so the repository guard and the
    // workflow_run conclusion check have to be merged with `&&`.
    expect(guardLines, "job build has exactly one guard line").toHaveLength(1);
    const guard = guardLines[0] ?? "";
    expect(guard, "job build guard is job-level").toMatch(/^ {4}if:/);
    expect(guard).toContain(GUARD);
    // The workflow_run conclusion check must survive the merge.
    expect(guard).toContain("github.event_name != 'workflow_run'");
    expect(guard).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(guard).toContain("&&");
  });

  it("does not mistake a step-level condition for a job-level guard", () => {
    // A step-level `if:` is nested deeper than the job-level one, so adding one
    // must not change the number of guards the job is considered to have.
    // The fixture is built inline: this exercises the parsing helpers, so it
    // must not depend on the wording of a real workflow file.
    const jobWithGuardOnly = ["", "jobs:", "  update:", "    if: github.repository == 't8y2/dbx'", "    steps:", "      - uses: actions/checkout@v7", ""].join("\n");
    expect(jobGuardLines(jobWithGuardOnly, "update"), "the job has one guard").toHaveLength(1);

    const jobWithStepCondition = ["", "jobs:", "  update:", "    if: github.repository == 't8y2/dbx'", "    steps:", "      - uses: actions/checkout@v7", "        if: github.ref == 'refs/heads/main'", ""].join("\n");
    expect(jobGuardLines(jobWithStepCondition, "update"), "the job still has one guard").toHaveLength(1);
  });

  it("preserves the triggers, permissions, and destinations of the guarded workflows", () => {
    const dailyBeta = readWorkflow("daily-beta-release.yml");
    // Triggers: the daily schedule and a manual dispatch.
    expect(dailyBeta).toContain('cron: "15 18 * * *"');
    expect(dailyBeta).toContain("workflow_dispatch:");
    expect(dailyBeta).toContain("contents: write");
    expect(dailyBeta).toContain("group: daily-beta-release");
    // The beta tag is still dispatched through the upstream release workflow.
    expect(dailyBeta).toContain("secrets.MCP_RELEASE_TOKEN");

    const docs = readWorkflow("docs.yml");
    expect(docs).toContain('paths: ["docs/**"]');
    expect(docs).toContain("workflow_run:");
    expect(docs).toContain('workflows: ["Sync Changelog to R2", "Agents Release"]');
    expect(docs).toContain("contents: read");
    expect(docs).toContain("group: pages");
    // The Cloudflare Workers deployment target is unchanged.
    expect(docs).toContain("pnpm dlx wrangler@4 deploy");
    expect(docs).toContain("secrets.CLOUDFLARE_API_TOKEN");

    const dockerHub = readWorkflow("dockerhub-description.yml");
    expect(dockerHub).toContain('"deploy/dockerhub/README.md"');
    expect(dockerHub).toContain("workflow_dispatch:");
    expect(dockerHub).toContain("contents: read");
    // The description still points at the upstream Docker Hub account.
    expect(dockerHub).toContain("secrets.DOCKERHUB_USERNAME");
    expect(dockerHub).toContain("peter-evans/dockerhub-description@v5");

    const nixHash = readWorkflow("update-nix-pnpm-hash.yml");
    expect(nixHash).toContain("'package.json'");
    expect(nixHash).toContain("'pnpm-lock.yaml'");
    expect(nixHash).toContain("'flake.nix'");
    expect(nixHash).toContain("workflow_dispatch:");
    expect(nixHash).toContain("contents: write");
    expect(nixHash).toContain("group: update-nix-pnpm-hash-${{ github.ref }}");
    // The owner PAT check stays in place for the upstream repository.
    expect(nixHash).toContain("secrets.MCP_RELEASE_TOKEN || secrets.PROJECT_AUTOMATION_TOKEN");
  });
});
