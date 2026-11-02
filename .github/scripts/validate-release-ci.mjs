import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateReleaseCi(pages, sha) {
  const runs = pages.flatMap((page) => page.workflow_runs ?? [])
    .filter((run) => run.head_sha === sha && ["push", "pull_request"].includes(run.event))
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const latest = runs[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(`Latest CI run for ${sha} must complete successfully before promotion (${latest ? `${latest.status}/${latest.conclusion}` : "no CI run"}).`);
  }
  return latest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, sha] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/i.test(sha ?? "")) {
    throw new Error("Usage: validate-release-ci.mjs <owner/repo> <commit-sha>");
  }
  // Query the CI workflow alone: the promotion workflow runs on the same
  // commit and must never fail its own gate merely because it is in progress.
  const pages = JSON.parse(execFileSync("gh", [
    "api", "--paginate", "--slurp",
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
  ], { encoding: "utf8" }));
  const run = validateReleaseCi(pages, sha);
  console.log(`Validated CI run ${run.id} for ${sha}.`);
}
