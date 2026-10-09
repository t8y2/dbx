import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { goAgents, integrationCases, rustAgents, rustGroups } from "./ci-config.mjs";

const win7InfrastructureFiles = new Set([
  ".github/scripts/assert-win7-pe-compat.ps1",
  ".github/scripts/assert-webview2-win7-loader.ps1",
  ".github/scripts/assert-win7-installer-content.ps1",
  ".github/scripts/assert-webview2-win7-runtime.ps1",
  ".github/scripts/prepare-webview2-win7-loader.ps1",
  ".github/scripts/prepare-webview2-win7-runtime.ps1",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "src-tauri/tauri.webview2-win7-fixed.conf.json",
  "src-tauri/build.rs",
]);
const win7InfrastructurePrefixes = [
  "src-tauri/windows/nsis/",
  "vendor/wry/",
  "vendor/webview2-com-sys/",
  "vendor/ctor/",
  "vendor/dirs-sys/",
  "vendor/pageant/",
];

function expandAffectedPackages(packages, members, affected) {
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
}

export function changedPaths(base, root) {
  if (!base || /^0+$/.test(base)) return null;
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: root, stdio: "pipe" });
  return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
}

export function knownJavaDrivers(root, nativeDrivers) {
  try {
    const driversRoot = path.join(root, "agents/drivers");
    return readdirSync(driversRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && existsSync(path.join(driversRoot, entry.name, "build.gradle"))
        && !nativeDrivers.includes(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function cargoMetadata(root, execute = execFileSync) {
  return JSON.parse(execute("cargo", ["+stable", "metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
}

export function planCi({ files, metadata, root, eventName = "pull_request", rustChanged = false, agentsChanged = false, javaDrivers }) {
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
    if (file.startsWith("plugins/dialects/")) affected.add("dbx-sql-dialect");
  }
  const knownGroups = new Set(Object.values(rustGroups).flat());
  const unknownMember = packages.some((pkg) => !knownGroups.has(pkg.name));
  const rust = rustChanged || sharedRust || unknownRust || affected.size > 0 || files.includes("scripts/core-architecture.test.mjs");
  const full = rust && (eventName !== "pull_request" || sharedRust || unknownRust || unknownMember || affected.size === 0);
  const win7Affected = new Set(affected);
  expandAffectedPackages(packages, members, win7Affected);
  if (full) for (const pkg of packages) affected.add(pkg.name);
  expandAffectedPackages(packages, members, affected);
  const win7InfrastructureChanged = unknownDiff || files.some((file) => win7InfrastructureFiles.has(file)
    || win7InfrastructurePrefixes.some((prefix) => file.startsWith(prefix)));
  const win7DependencyChanged = files.includes("Cargo.toml") || files.includes("Cargo.lock")
    || files.some((file) => /^(?:crates\/[^/]+|src-tauri)\/Cargo\.toml$/.test(file));
  const windowsWin7Reasons = {
    infrastructure: win7InfrastructureChanged,
    dependency_input: win7DependencyChanged,
    desktop_dependency: win7Affected.has("dbx"),
    unknown_rust: unknownRust,
  };
  const windowsWin7Candidate = Object.values(windowsWin7Reasons).some(Boolean);
  const rustMatrix = !rust ? [] : full ? [{ group: "workspace" }] : Object.entries(rustGroups)
    .filter(([, names]) => names.some((name) => affected.has(name)))
    .map(([group]) => ({ group }));
  const nativeDrivers = [...goAgents.map((agent) => agent.driver), ...rustAgents];
  const jdbcDrivers = javaDrivers ?? knownJavaDrivers(root, nativeDrivers);
  const nativeChanges = new Set(nativeDrivers.filter((driver) => files.some((file) => file.startsWith(`agents/drivers/${driver}/`))));
  const javaDriverChanges = jdbcDrivers.some((driver) => files.some((file) => file.startsWith(`agents/drivers/${driver}/`)));
  // Driver-scoped JDBC/Go/Rust trees are not "shared Agent inputs". Unknown
  // agents/drivers/<name>/ paths still fail open to full coverage below.
  const sharedAgents = ciChanged || sharedRust || files.some((file) => file.startsWith("agents/")
    && !nativeDrivers.some((driver) => file.startsWith(`agents/drivers/${driver}/`))
    && !jdbcDrivers.some((driver) => file.startsWith(`agents/drivers/${driver}/`)))
    || files.some((file) => file.startsWith(".github/scripts/bump-agent-versions.") || file === ".github/workflows/agents-release.yml"
      || file === "crates/dbx-driver-agent/assets/agent-protocol-v2.json");
  const allAgents = sharedAgents || (agentsChanged && nativeChanges.size === 0 && !javaDriverChanges);
  if (allAgents) {
    for (const driver of nativeDrivers) nativeChanges.add(driver);
  }
  if (affected.has("dbx-core")) nativeChanges.add("duckdb");
  const goMatrix = goAgents.filter((agent) => nativeChanges.has(agent.driver));
  const nativeRustMatrix = rustAgents.filter((driver) => nativeChanges.has(driver)).map((driver) => ({ driver }));
  const liveMatrix = integrationCases.filter((entry) => nativeChanges.has(entry.driver));
  const java = allAgents || javaDriverChanges;
  const agents = agentsChanged || sharedAgents || nativeChanges.size > 0 || javaDriverChanges;
  return {
    rust, rust_full: full, rust_matrix: { include: rustMatrix }, rust_groups_known: !unknownMember,
    affected_packages: [...affected].sort(),
    agents, agent_java: java, agent_go: { include: goMatrix }, agent_rust: { include: nativeRustMatrix },
    agent_integration: { include: liveMatrix }, agent_go_changed: goMatrix.length > 0,
    agent_rust_changed: nativeRustMatrix.length > 0, agent_integration_changed: liveMatrix.length > 0,
    duckdb_changed: nativeChanges.has("duckdb"),
    duckdb_windows: sharedRust || files.some((file) => file.startsWith("agents/drivers/duckdb/")),
    windows_win7_candidate: windowsWin7Candidate,
    windows_win7_affected_packages: [...win7Affected].sort(),
    windows_win7_reasons: windowsWin7Reasons,
    fast: rust || agents || ciChanged,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd();
  const metadata = cargoMetadata(root);
  const plan = planCi({
    files: changedPaths(process.env.BASE_SHA, root), metadata, root, eventName: process.env.GITHUB_EVENT_NAME,
    rustChanged: process.env.RUST_CHANGED === "true", agentsChanged: process.env.AGENTS_CHANGED === "true",
  });
  if (process.env.GITHUB_OUTPUT) {
    const outputs = { ...plan, plan };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([name, value]) => `${name}=${JSON.stringify(value)}\n`).join(""));
  }
  console.log(JSON.stringify({
    ...plan,
    win7_routing_comparison: {
      current: process.env.WIN7_CURRENT === "true",
      candidate: plan.windows_win7_candidate,
      affected_packages: plan.windows_win7_affected_packages,
      reasons: plan.windows_win7_reasons,
    },
  }, null, 2));
}
