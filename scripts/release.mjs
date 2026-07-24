import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { evaluateAgentVersionBump, getAgentVersionChanges, isAgentPublishRelevantFile, parseLegacyStandaloneProjects } from "../.github/scripts/bump-agent-versions.mjs";

const REPO = "t8y2/dbx";
const PACKAGES_WORKFLOW = "mcp-release.yml";
const APP_PUBLISH_WORKFLOW = "publish-packages.yml";
const APP_CNB_SYNC_WORKFLOW = "sync-cnb-release-assets.yml";
const APP_DOCKER_ROLLBACK_WORKFLOW = "rollback-docker-latest.yml";
const PACKAGE_TAG_PREFIX = "packages-v";
const AGENT_TAG_PREFIX = "agents-v";
const APP_TAG_PREFIX = "v";
const PACKAGE_RELEASE_PATHS = [
  "packages/cli/src/",
  "packages/cli/README.md",
  "packages/cli/package.json",
  "packages/cli/bin/",
  "packages/cli-darwin-arm64/",
  "packages/cli-darwin-x64/",
  "packages/cli-linux-arm64-gnu/",
  "packages/cli-linux-x64-gnu/",
  "packages/cli-win32-arm64/",
  "packages/cli-win32-x64/",
  "packages/mcp-server/bin/",
  "packages/mcp-server/README.md",
  "packages/mcp-server/package.json",
  "packages/mcp-server/server.json",
  "packages/mcp-darwin-arm64/",
  "packages/mcp-darwin-x64/",
  "packages/mcp-linux-arm64-gnu/",
  "packages/mcp-linux-x64-gnu/",
  "packages/mcp-win32-arm64/",
  "packages/mcp-win32-x64/",
  "crates/dbx-mcp/",
  "crates/dbx-cli/",
  "crates/dbx-core/src/mongo_shell.rs",
  "Cargo.toml",
  "Cargo.lock",
  ".github/workflows/mcp-release.yml",
];
const AGENT_RELEASE_PATHS = [
  "agents/build.gradle",
  "agents/settings.gradle",
  "agents/versions.json",
  "agents/common/build.gradle",
  "agents/common/src/main/",
  "agents/drivers/",
];

const args = process.argv.slice(2);
let target = null;
let requestedBump = null;
let dryRun = false;
let yes = false;
let skipFetch = false;
let force = false;

// NO_COLOR (https://no-color.org) wins, then FORCE_COLOR, then autodetect TTY.
const USE_COLOR = !process.env.NO_COLOR && (process.stdout.isTTY || (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0"));
function ansi(code, text) {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (s) => ansi(1, s);
const dim = (s) => ansi(2, s);
const cyan = (s) => ansi(36, s);
const green = (s) => ansi(32, s);
const yellow = (s) => ansi(33, s);
const red = (s) => ansi(31, s);
const magenta = (s) => ansi(35, s);
// `Label: value` with a dimmed label and a colored value.
function kv(label, value, color = cyan) {
  return `${dim(label)}: ${color(value)}`;
}

for (const arg of args) {
  switch (arg) {
    case "--":
      break;
    case "--dry-run":
      dryRun = true;
      break;
    case "-y":
    case "--yes":
      yes = true;
      break;
    case "--skip-fetch":
      skipFetch = true;
      break;
    case "--force":
      force = true;
      break;
    case "-h":
    case "--help":
      printHelp();
      process.exit(0);
      break;
    default: {
      const normalizedTarget = normalizeTarget(arg);
      if (!target && normalizedTarget) {
        target = normalizedTarget;
      } else if (!requestedBump) {
        requestedBump = arg;
      } else {
        fail(`Unexpected argument: ${arg}`);
      }
      break;
    }
  }
}

const repoRoot = run("git", ["rev-parse", "--show-toplevel"]).stdout.trim();
process.chdir(repoRoot);

if (!skipFetch) {
  fetchReleaseTags();
}

if (!target) {
  if (!process.stdin.isTTY) {
    fail("Release target is required in a non-interactive shell. Use packages, agents, app, or rollback.");
  }
  target = await promptTarget();
}

if (target === "packages") {
  await releasePackages(requestedBump ?? "patch");
} else if (target === "agents") {
  await releaseAgents(requestedBump ?? "patch");
} else if (target === "app") {
  await publishApp(requestedBump);
} else if (target === "rollback") {
  await rollbackApp(requestedBump);
} else {
  fail(`Unknown release target: ${target}`);
}

async function releasePackages(bump) {
  const status = getPackageReleaseStatus();
  const latestVersion = status.latestVersion ?? getLatestPackageVersion();
  const releaseVersion = resolveReleaseVersion(bump, latestVersion, PACKAGE_TAG_PREFIX);
  const releaseTag = `${PACKAGE_TAG_PREFIX}${releaseVersion}`;
  const workflowArgs = ["workflow", "run", PACKAGES_WORKFLOW, "--repo", REPO, "-f", `version=${releaseVersion}`];

  console.log(kv("Release target", "Node packages / MCP", bold));
  console.log(kv("Current package version", latestVersion ?? "none", green));
  printReleaseStatus(status);
  if (!status.needed && !force) {
    console.log(yellow("No Node package release needed; publish-relevant package files have not changed."));
    console.log(dim("Use --force to trigger the workflow anyway."));
    return;
  }
  console.log(kv("New package version", releaseVersion, green));
  console.log(kv("Release tag", releaseTag, yellow));
  console.log(kv("Workflow", `Node Packages Release (${PACKAGES_WORKFLOW})`, magenta));
  console.log(kv("Command", `gh ${workflowArgs.join(" ")}`, dim));

  if (dryRun) {
    console.log(dim("Dry run only; workflow was not triggered."));
    return;
  }

  ensureGhReady(PACKAGES_WORKFLOW);
  await confirmOrExit(`Confirm triggering Node Packages Release for ${bold(releaseVersion)}? [y/N] `);

  run("gh", workflowArgs, { stdio: "inherit" });
  console.log(green(`Triggered Node Packages Release for ${releaseVersion}.`));
}

async function releaseAgents(bump) {
  const latest = getLatestAgentTag();
  const status = getAgentReleaseStatus(latest);
  const releaseTag = resolveAgentTag(bump, latest.tag);

  if (tagExists(releaseTag)) {
    fail(`Tag ${releaseTag} already exists.`);
  }

  console.log(kv("Release target", "Agents", bold));
  console.log(kv("Current agent tag", `${latest.tag}${latest.source ? ` (${latest.source})` : ""}`, yellow));
  printReleaseStatus(status);
  printAgentVersionChanges(latest.tag, status.changedFiles);
  if (!status.needed && !force) {
    console.log(yellow("No agents release needed; publish-relevant agent runtime files have not changed."));
    console.log(dim("Use --force to create the tag anyway."));
    return;
  }
  console.log(kv("New agent tag", releaseTag, yellow));
  console.log(kv("Workflow", "Agents Release (.github/workflows/agents-release.yml)", magenta));
  console.log(kv("Commands", `git tag ${releaseTag} && git push origin ${releaseTag}`, dim));

  if (dryRun) {
    console.log(dim("Dry run only; tag was not created or pushed."));
    return;
  }

  await confirmOrExit(`Confirm creating and pushing tag ${bold(releaseTag)}? [y/N] `);

  run("git", ["tag", releaseTag], { stdio: "inherit" });
  run("git", ["push", "origin", releaseTag], { stdio: "inherit" });
  console.log(green(`Pushed ${releaseTag}; Agents Release will run from the tag push.`));
}

async function publishApp(tagInput) {
  const latest = getLatestAppTag();
  const releaseTag = tagInput ? resolveAppTag(tagInput) : latest.tag;
  const workflowArgs = ["workflow", "run", APP_PUBLISH_WORKFLOW, "--repo", REPO, "-f", `tag=${releaseTag}`];

  console.log(kv("Release target", "App distribution", bold));
  console.log(kv("Latest app tag", latest.tag, yellow));
  console.log(kv("Publish tag", releaseTag, yellow));
  console.log(kv("Workflow", `Publish Packages (${APP_PUBLISH_WORKFLOW})`, magenta));
  console.log(kv("Command", `gh ${workflowArgs.join(" ")}`, dim));

  if (dryRun) {
    console.log(dim("Dry run only; workflow was not triggered."));
    return;
  }

  ensureGhReady(APP_PUBLISH_WORKFLOW);
  run("gh", ["release", "view", releaseTag, "--repo", REPO], { stdio: "inherit" });
  await confirmOrExit(`Confirm publishing app distribution for ${bold(releaseTag)}? [y/N] `);

  run("gh", workflowArgs, { stdio: "inherit" });
  console.log(green(`Triggered Publish Packages for ${releaseTag}.`));
}

async function rollbackApp(tagInput) {
  const releaseTag = resolveRollbackTag(tagInput ?? (await promptRollbackTag()));
  const publishArgs = ["workflow", "run", APP_PUBLISH_WORKFLOW, "--repo", REPO, "-f", `tag=${releaseTag}`, "-f", "notify=false"];
  const cnbArgs = ["workflow", "run", APP_CNB_SYNC_WORKFLOW, "--repo", REPO, "-f", `tag=${releaseTag}`];
  const dockerArgs = ["workflow", "run", APP_DOCKER_ROLLBACK_WORKFLOW, "--repo", REPO, "-f", `tag=${releaseTag}`];

  console.log(kv("Release target", "Emergency app rollback", bold));
  console.log(kv("Rollback tag", releaseTag, yellow));
  console.log(yellow("This stops further rollout but does not downgrade clients that already installed a newer version."));
  console.log(kv("GitHub / R2 / Homebrew / Scoop", `gh ${publishArgs.join(" ")}`, dim));
  console.log(kv("CNB release assets", `gh ${cnbArgs.join(" ")}`, dim));
  console.log(kv("Docker latest", `gh ${dockerArgs.join(" ")}`, dim));

  if (dryRun) {
    console.log(dim("Dry run only; rollback workflows were not triggered and release metadata was not changed."));
    return;
  }

  ensureGhWorkflowsReady([APP_PUBLISH_WORKFLOW, APP_CNB_SYNC_WORKFLOW, APP_DOCKER_ROLLBACK_WORKFLOW]);
  const latestRelease = getGithubRelease();
  const rollbackRelease = getGithubRelease(releaseTag);
  validateRollbackRelease(rollbackRelease, latestRelease);

  console.log(kv("Current latest release", latestRelease.tagName, red));
  console.log(kv("Rollback release", rollbackRelease.tagName, green));
  await confirmRollbackOrExit(releaseTag);

  // Dispatch existing credential-owning workflows instead of handling release secrets locally.
  run("gh", publishArgs, { stdio: "inherit" });
  run("gh", cnbArgs, { stdio: "inherit" });
  run("gh", dockerArgs, { stdio: "inherit" });
  console.log(green(`Triggered emergency rollback to ${releaseTag}. Monitor all three workflows before announcing completion.`));
}

async function promptTarget() {
  const packageStatus = getPackageReleaseStatus();
  const agentStatus = getAgentReleaseStatus(getLatestAgentTag());
  const answer = await ask(`${bold("Select release target:")}
  ${cyan("1")}. Node packages / MCP (${formatStatusSummary(packageStatus)})
  ${cyan("2")}. Agents (${formatStatusSummary(agentStatus)})
  ${cyan("3")}. App distribution
  ${cyan("4")}. Emergency app rollback
${dim("Choice")} [1]: `);

  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === "1" || normalized === "packages" || normalized === "mcp") return "packages";
  if (normalized === "2" || normalized === "agents" || normalized === "agent") return "agents";
  if (normalized === "3" || normalized === "app" || normalized === "desktop" || normalized === "publish") return "app";
  if (normalized === "4" || normalized === "rollback" || normalized === "revert") return "rollback";
  fail(`Unknown release target: ${answer}`);
}

async function promptRollbackTag() {
  if (!process.stdin.isTTY) {
    fail("Rollback tag is required in a non-interactive shell. Use rollback vX.Y.Z.");
  }
  return ask(`Rollback to published app tag ${dim("(for example v0.5.63)")}: `);
}

async function confirmOrExit(message) {
  if (yes) return;
  if (!process.stdin.isTTY) {
    fail("Refusing to trigger release without confirmation in a non-interactive shell. Re-run with --yes if this is intentional.");
  }

  const answer = await ask(message);
  if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
    console.log(dim("Cancelled."));
    process.exit(0);
  }
}

async function confirmRollbackOrExit(releaseTag) {
  if (yes) return;
  if (!process.stdin.isTTY) {
    fail("Refusing to trigger rollback without confirmation in a non-interactive shell. Re-run with --yes if this is intentional.");
  }

  // A typed tag makes accidental selection of this destructive menu action much less likely.
  const answer = await ask(`Type ${bold(releaseTag)} to confirm the emergency rollback: `);
  if (answer.trim() !== releaseTag) {
    console.log(dim("Cancelled."));
    process.exit(0);
  }
}

async function ask(question) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

function normalizeTarget(value) {
  if (["package", "packages", "node-packages", "node", "mcp"].includes(value)) return "packages";
  if (["agent", "agents"].includes(value)) return "agents";
  if (["app", "desktop", "publish", "publish-packages", "distribution"].includes(value)) return "app";
  if (["rollback", "revert", "emergency-rollback"].includes(value)) return "rollback";
  return null;
}

function resolveRollbackTag(value) {
  const releaseTag = resolveAppTag(value);
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
    fail("Emergency rollback only supports stable vX.Y.Z app releases.");
  }
  return releaseTag;
}

function getGithubRelease(tag) {
  const releaseArgs = ["release", "view"];
  if (tag) releaseArgs.push(tag);
  releaseArgs.push("--repo", REPO, "--json", "tagName,isDraft,isPrerelease,publishedAt,assets");
  return JSON.parse(run("gh", releaseArgs).stdout);
}

function validateRollbackRelease(rollbackRelease, latestRelease) {
  if (rollbackRelease.isDraft || rollbackRelease.isPrerelease || !rollbackRelease.publishedAt) {
    fail(`Rollback target ${rollbackRelease.tagName} must be a published stable release.`);
  }

  const rollbackVersion = parseVersion(rollbackRelease.tagName.replace(/^v/, ""));
  const latestVersion = parseVersion(latestRelease.tagName.replace(/^v/, ""));
  if (!rollbackVersion || !latestVersion || compareVersions(rollbackVersion, latestVersion) >= 0) {
    fail(`Rollback target ${rollbackRelease.tagName} must be older than the current latest release ${latestRelease.tagName}.`);
  }

  const version = formatVersion(rollbackVersion);
  const requiredAssets = [
    "latest.json",
    `DBX_${version}_aarch64.dmg`,
    `DBX_${version}_x64.dmg`,
    `DBX_${version}_x64-setup.exe`,
    `DBX_${version}_arm64-setup.exe`,
  ];
  const assetNames = new Set(rollbackRelease.assets.map((asset) => asset.name));
  const missingAssets = requiredAssets.filter((asset) => !assetNames.has(asset));
  if (missingAssets.length > 0) {
    fail(`Rollback target ${rollbackRelease.tagName} is missing required distribution assets: ${missingAssets.join(", ")}`);
  }
}

function getLatestPackageVersion() {
  const tag = getLatestSemverTag(PACKAGE_TAG_PREFIX);
  if (tag) return tag.versionText;

  const packageVersions = [
    "packages/cli/package.json",
    "packages/mcp-server/package.json",
    "packages/mcp-darwin-arm64/package.json",
    "packages/mcp-darwin-x64/package.json",
    "packages/mcp-linux-arm64-gnu/package.json",
    "packages/mcp-linux-x64-gnu/package.json",
    "packages/mcp-win32-arm64/package.json",
    "packages/mcp-win32-x64/package.json",
  ].map((path) => JSON.parse(readFileSync(path, "utf8")).version);

  const uniqueVersions = [...new Set(packageVersions)];
  if (uniqueVersions.length !== 1) {
    fail(`Package versions differ and no ${PACKAGE_TAG_PREFIX} tag was found: ${uniqueVersions.join(", ")}`);
  }

  return uniqueVersions[0];
}

function getPackageReleaseStatus() {
  const latest = getLatestSemverTag(PACKAGE_TAG_PREFIX);
  if (!latest) {
    return {
      needed: true,
      baseline: "no packages-v* tag",
      latestVersion: getLatestPackageVersion(),
      changedFiles: [],
      reason: "No previous package release tag was found.",
    };
  }

  const changedFiles = getChangedFilesSince(latest.tag, PACKAGE_RELEASE_PATHS);
  return {
    needed: changedFiles.length > 0,
    baseline: latest.tag,
    latestVersion: latest.versionText,
    changedFiles,
  };
}

function getLatestAgentTag() {
  const tag = getLatestSemverTag(AGENT_TAG_PREFIX);
  if (tag) return { tag: tag.tag, source: "current repo" };

  const legacyRepo = "../dbx-agents";
  const legacyRepoCheck = spawnSync("git", ["-C", legacyRepo, "rev-parse", "--is-inside-work-tree"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });

  if (legacyRepoCheck.status === 0) {
    const legacyTags = run("git", ["-C", legacyRepo, "tag", "--list", "v*"]).stdout
      .split(/\r?\n/)
      .map((legacyTag) => legacyTag.trim())
      .filter(Boolean)
      .map((legacyTag) => ({ legacyTag, version: parseVersion(legacyTag.replace(/^v/, "")) }))
      .filter((entry) => entry.version)
      .sort((a, b) => compareVersions(b.version, a.version));

    if (legacyTags.length > 0) {
      return {
        tag: `${AGENT_TAG_PREFIX}${formatVersion(legacyTags[0].version)}`,
        source: `${legacyRepo} ${legacyTags[0].legacyTag}`,
      };
    }
  }

  return { tag: `${AGENT_TAG_PREFIX}0.0.0`, source: "initial baseline" };
}

function getAgentReleaseStatus(latest = getLatestAgentTag()) {
  if (!refExists(`refs/tags/${latest.tag}`)) {
    return {
      needed: true,
      baseline: `${latest.tag} (${latest.source ?? "missing local tag"})`,
      changedFiles: [],
      reason: "No comparable local agents release tag was found.",
    };
  }

  const changedFiles = getChangedFilesSince(latest.tag, AGENT_RELEASE_PATHS).filter(isAgentPublishRelevantFile);
  return {
    needed: changedFiles.length > 0,
    baseline: latest.tag,
    changedFiles,
  };
}

function getLatestAppTag() {
  const tag = getLatestSemverTag(APP_TAG_PREFIX);
  if (!tag) {
    fail("No v* app release tag was found.");
  }
  return { tag: tag.tag };
}

function getChangedFilesSince(ref, paths) {
  const output = run("git", ["diff", "--name-only", `${ref}..HEAD`, "--", ...paths]).stdout.trim();
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean);
}

function printReleaseStatus(status) {
  console.log(kv("Release needed", status.needed ? "yes" : "no", status.needed ? yellow : green));
  console.log(kv("Compared against", status.baseline, dim));
  if (status.reason) {
    console.log(kv("Reason", status.reason, dim));
  }
  if (status.changedFiles.length > 0) {
    console.log(dim("Changed publish-relevant files:"));
    for (const file of status.changedFiles.slice(0, 20)) {
      console.log(`  ${dim("-")} ${file}`);
    }
    if (status.changedFiles.length > 20) {
      console.log(dim(`  ... and ${status.changedFiles.length - 20} more`));
    }
  }
}

function printAgentVersionChanges(baselineTag, changedFiles) {
  if (changedFiles.length === 0 || !refExists(`refs/tags/${baselineTag}`)) return;

  const currentVersions = JSON.parse(readFileSync("agents/versions.json", "utf8"));
  const previousVersions = JSON.parse(run("git", ["show", `${baselineTag}:agents/versions.json`]).stdout);
  const legacyStandaloneModules = parseLegacyStandaloneProjects(readFileSync("agents/build.gradle", "utf8"));
  const result = evaluateAgentVersionBump({
    versions: currentVersions,
    prevVersions: previousVersions,
    changedFiles,
    legacyStandaloneModules,
    manualVersionsChanged: changedFiles.includes("agents/versions.json"),
  });
  const changes = getAgentVersionChanges(previousVersions, result.versions)
    .map(({ moduleName, previousVersion, nextVersion }) => `${moduleName}: ${previousVersion ?? "new"} -> ${nextVersion}`);

  if (changes.length === 0) {
    console.log(dim("No automatic driver version changes detected."));
    return;
  }

  console.log(dim("Expected driver version changes:"));
  for (const change of changes) {
    console.log(`  ${dim("-")} ${change}`);
  }
}

function formatStatusSummary(status) {
  if (status.needed) {
    const detail = status.changedFiles.length > 0 ? `${status.changedFiles.length} changed file${status.changedFiles.length === 1 ? "" : "s"}` : "release baseline missing";
    return `${yellow("needs release")}, ${detail}`;
  }
  return `${green("no release needed")} since ${status.baseline}`;
}

function getLatestSemverTag(prefix) {
  const tags = run("git", ["tag", "--list", `${prefix}*`]).stdout
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: parseVersion(tag.replace(prefix, "")) }))
    .filter((entry) => entry.version)
    .sort((a, b) => compareVersions(b.version, a.version));

  if (tags.length === 0) return null;
  return { ...tags[0], versionText: formatVersion(tags[0].version) };
}

function refExists(ref) {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", ref], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function resolveAgentTag(bump, latestTag) {
  const explicitVersion = normalizeExplicitVersion(bump, AGENT_TAG_PREFIX);
  if (explicitVersion) return `${AGENT_TAG_PREFIX}${explicitVersion}`;

  const latestVersion = latestTag.replace(AGENT_TAG_PREFIX, "");
  return `${AGENT_TAG_PREFIX}${resolveReleaseVersion(bump, latestVersion, AGENT_TAG_PREFIX)}`;
}

function resolveAppTag(value) {
  if (["patch", "minor", "major"].includes(value)) {
    fail("App distribution publishing requires an existing vX.Y.Z release tag, not a version bump.");
  }

  const explicitVersion = normalizeExplicitVersion(value, APP_TAG_PREFIX);
  if (!explicitVersion) {
    fail(`Invalid app release tag '${value}'. Use vX.Y.Z or X.Y.Z.`);
  }

  return `${APP_TAG_PREFIX}${explicitVersion}`;
}

function resolveReleaseVersion(bump, latestVersion, explicitTagPrefix) {
  const normalizedVersion = normalizeExplicitVersion(bump, explicitTagPrefix);
  if (normalizedVersion) return normalizedVersion;

  if (!["patch", "minor", "major"].includes(bump)) {
    fail(`Unknown version bump '${bump}'. Use patch, minor, major, or an explicit semver version.`);
  }

  const latest = parseVersion(latestVersion);
  if (!latest || latest.prerelease) {
    fail(`Cannot ${bump} bump from non-standard version '${latestVersion}'. Pass an explicit version instead.`);
  }

  if (bump === "major") return `${latest.major + 1}.0.0`;
  if (bump === "minor") return `${latest.major}.${latest.minor + 1}.0`;
  return `${latest.major}.${latest.minor}.${latest.patch + 1}`;
}

function normalizeExplicitVersion(value, explicitTagPrefix) {
  const trimmed = value.trim().replace(new RegExp(`^${escapeRegExp(explicitTagPrefix)}`), "").replace(/^v/, "");
  const version = parseVersion(trimmed);
  return version ? formatVersion(version) : null;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease ? `-${version.prerelease}` : ""}`;
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function tagExists(tag) {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function ensureGhReady(workflow) {
  run("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "inherit" });
  run("gh", ["workflow", "view", workflow, "--repo", REPO], { stdio: "inherit" });
}

function ensureGhWorkflowsReady(workflows) {
  run("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "inherit" });
  for (const workflow of workflows) {
    run("gh", ["workflow", "view", workflow, "--repo", REPO], { stdio: "inherit" });
  }
}

function fetchReleaseTags() {
  run("git", [
    "fetch",
    "--quiet",
    "origin",
    "+refs/tags/v*:refs/tags/v*",
    "+refs/tags/packages-v*:refs/tags/packages-v*",
    "+refs/tags/agents-v*:refs/tags/agents-v*",
  ]);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });

  if (result.error) {
    fail(`${command} ${commandArgs.join(" ")} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    fail(`${command} ${commandArgs.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
  }

  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(red(message));
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: node scripts/release.mjs [packages|agents|app|rollback] [patch|minor|major|version] [options]

Unified release and emergency rollback trigger for DBX packages, agents, and app distribution.

Targets:
  packages              Trigger Node Packages Release via gh workflow run
  agents                Create and push an agents-v* tag
  app                   Trigger Publish Packages for an existing v* app release tag
  rollback              Roll app distribution channels back to an older published v* tag

Arguments:
  patch                 Bump the latest target tag by one patch version (default)
  minor                 Bump the latest target tag by one minor version
  major                 Bump the latest target tag by one major version
  0.4.14                Trigger an explicit version
  packages-v0.4.14      Explicit package tag style, for packages
  agents-v0.4.14        Explicit agent tag style, for agents
  v0.5.38               Existing app release tag, for app
  rollback v0.5.63      Emergency rollback target tag

Options:
  --dry-run             Print the release command without triggering it
  -y, --yes             Skip the confirmation prompt
  --skip-fetch          Do not run git fetch --tags before reading release tags
  --force               Allow a package/agent release even when no relevant files changed
  -h, --help            Show this help
`);
}
