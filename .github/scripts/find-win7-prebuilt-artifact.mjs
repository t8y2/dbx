import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function selectMainArtifact(artifacts, name, repositoryId) {
  return artifacts
    .filter((artifact) =>
      artifact.name === name &&
      !artifact.expired &&
      artifact.workflow_run?.head_branch === "main" &&
      artifact.workflow_run?.repository_id === repositoryId &&
      artifact.workflow_run?.head_repository_id === repositoryId
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
}

export async function findMainArtifact({ name, repository, repositoryId, token, request = fetch }) {
  const url = new URL(`https://api.github.com/repos/${repository}/actions/artifacts`);
  url.searchParams.set("name", name);
  url.searchParams.set("per_page", "100");
  const response = await request(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub artifact lookup returned HTTP ${response.status}`);
  const result = await response.json();
  return selectMainArtifact(result.artifacts ?? [], name, repositoryId);
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log("Usage: WIN7_PREBUILT_ARTIFACT_NAME=NAME node find-win7-prebuilt-artifact.mjs");
    return;
  }

  const name = process.env.WIN7_PREBUILT_ARTIFACT_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  if (!name || !repository || !Number.isSafeInteger(repositoryId) || !token || !output) {
    throw new Error("Win7 artifact lookup requires a name, repository, repository ID, token, and output path.");
  }

  let runId = "";
  try {
    const artifact = await findMainArtifact({ name, repository, repositoryId, token });
    runId = artifact ? String(artifact.workflow_run.id) : "";
  } catch (error) {
    console.warn(`Win7 artifact lookup failed. The job will build locally. ${error.message}`);
  }

  appendFileSync(output, `name=${name}\nrun_id=${runId}\n`);
  console.log(runId ? `Found main artifact from run ${runId}.` : "No main artifact found. The job will build locally.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
