import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { goAgents, integrationCases, rustAgents, rustGroups } from "./ci-config.mjs";

export function changedPaths(base, root) {
  if (!base || /^0+$/.test(base)) return null;
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: root, stdio: "pipe" });
  return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

export function planCi({ files, metadata, root, eventName = "pull_request", rustChanged = false, agentsChanged = false }) {
  const unknownDiff = files === null;
  files ??= [];
  const packages = metadata.packages.filter((pkg) => metadata.workspace_members.includes(pkg.id));
  const members = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const packagePaths = packages.map((pkg) => [pkg.name, `${path.relative(root, path.dirname(pkg.manifest_path)).split(path.sep).join("/")}/`]);
  const ciChanged = unknownDiff || files.some((file) => /^\.github\/(?:workflows\/ci(?:[.-]|\/)|scripts\/ci-|actions\/ci-)/.test(file));
  const sharedRust = ciChanged || files.some((file) => /^(?:Cargo\.(?:toml|lock)$|rust-toolchain|\.cargo\/|vendor\/)/.test(file)
    || /^(?:crates\/[^/]+|src-tauri)\/Cargo\.toml$/.test(file));
  const affected = new Set();
  let unknownRust = false;
  for (const file of files) {
    const owner = packagePaths.find(([, directory]) => file.startsWith(directory));
    if (owner) affected.add(owner[0]);
    else if (/^(?:crates|src-tauri)\//.test(file)) unknownRust = true;
    if (file.startsWith("plugins/connection-types/")) affected.add("dbx-types");
    if (file.startsWith("plugins/dialects/")) affected.add("dbx-sql");
  }
  const knownGroups = new Set(Object.values(rustGroups).flat());
  const unknownMember = packages.some((pkg) => !knownGroups.has(pkg.name));
  const rust = rustChanged || sharedRust || unknownRust || affected.size > 0 || files.includes("scripts/core-architecture.test.mjs");
  const full = rust && (eventName !== "pull_request" || sharedRust || unknownRust || unknownMember || affected.size === 0);
  if (full) for (const pkg of packages) affected.add(pkg.name);
  let expanded;
  do {
    expanded = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.dependencies.some((dependency) => members.has(dependency.name) && affected.has(dependency.name))) {
        affected.add(pkg.name);
        expanded = true;
      }
    }
  } while (expanded);
  const rustMatrix = !rust ? [] : full ? [{ group: "workspace" }] : Object.entries(rustGroups)
    .filter(([, names]) => names.some((name) => affected.has(name)))
    .map(([group]) => ({ group }));
  const nativeDrivers = [...goAgents.map((agent) => agent.driver), ...rustAgents];
  const nativeChanges = new Set(nativeDrivers.filter((driver) => files.some((file) => file.startsWith(`agents/drivers/${driver}/`))));
  const sharedAgents = ciChanged || sharedRust || files.some((file) => file.startsWith("agents/")
    && !nativeDrivers.some((driver) => file.startsWith(`agents/drivers/${driver}/`)))
    || files.some((file) => file.startsWith(".github/scripts/bump-agent-versions.") || file === ".github/workflows/agents-release.yml"
      || file === "crates/dbx-drivers/assets/agent-protocol-v2.json");
  const allAgents = sharedAgents || (agentsChanged && nativeChanges.size === 0);
  if (allAgents) {
    for (const driver of nativeDrivers) nativeChanges.add(driver);
  }
  if (affected.has("dbx-core")) nativeChanges.add("duckdb");
  const goMatrix = goAgents.filter((agent) => nativeChanges.has(agent.driver));
  const nativeRustMatrix = rustAgents.filter((driver) => nativeChanges.has(driver)).map((driver) => ({ driver }));
  const liveMatrix = integrationCases.filter((entry) => nativeChanges.has(entry.driver));
  const java = allAgents;
  const agents = agentsChanged || sharedAgents || nativeChanges.size > 0;
  return {
    rust, rust_full: full, rust_matrix: { include: rustMatrix }, rust_groups_known: !unknownMember,
    affected_packages: [...affected].sort(),
    agents, agent_java: java, agent_go: { include: goMatrix }, agent_rust: { include: nativeRustMatrix },
    agent_integration: { include: liveMatrix }, agent_go_changed: goMatrix.length > 0,
    agent_rust_changed: nativeRustMatrix.length > 0, agent_integration_changed: liveMatrix.length > 0,
    duckdb_changed: nativeChanges.has("duckdb"),
    duckdb_windows: sharedRust || files.some((file) => file.startsWith("agents/drivers/duckdb/")),
    fast: rust || agents || ciChanged,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
  const plan = planCi({
    files: changedPaths(process.env.BASE_SHA, root), metadata, root, eventName: process.env.GITHUB_EVENT_NAME,
    rustChanged: process.env.RUST_CHANGED === "true", agentsChanged: process.env.AGENTS_CHANGED === "true",
  });
  if (process.env.GITHUB_OUTPUT) {
    const outputs = { ...plan, plan };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([name, value]) => `${name}=${JSON.stringify(value)}\n`).join(""));
  }
  console.log(JSON.stringify(plan, null, 2));
}
