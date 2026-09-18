import path from "node:path";
import { pathToFileURL } from "node:url";

export function gateFailures(needs, mode) {
  if (needs.changes?.result !== "success") return ["changes did not succeed"];
  let plan;
  try { plan = JSON.parse(needs.changes.outputs.plan); } catch { return ["missing or invalid CI plan"]; }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["incomplete CI plan"];
  const flags = ["rust", "agents", "fast", "agent_java", "agent_go_changed", "agent_rust_changed", "agent_integration_changed"];
  if (!flags.every((flag) => typeof plan[flag] === "boolean")) return ["incomplete CI plan"];
  const routedJobs = { frontend: "frontend", packages: "packages", "github-scripts": "github_scripts",
    "windows-win7-bundle": "windows_win7_bundle", "duckdb-windows-driver": "duckdb_windows",
    jdbc: "jdbc", "offline-jdbc-release": "offline_jdbc", "nix-packaging": "nix" };
  if (mode === "all" && !Object.values(routedJobs).every((output) => ["true", "false"].includes(needs.changes.outputs[output]))) {
    return ["missing or invalid job selection outputs"];
  }
  const expected = mode === "rust" ? {
    "fast-checks": plan.fast, "rust-fmt-clippy": plan.rust, "rust-test": plan.rust,
  } : mode === "agents" ? {
    "fast-checks": plan.fast, "agent-checks": plan.agents, "agent-java": plan.agent_java, "agent-go": plan.agent_go_changed,
    "agent-rust": plan.agent_rust_changed, "agent-integration": plan.agent_integration_changed,
  } : mode === "all" ? {
    rust: true, agents: true, "fast-checks": plan.fast,
    ...Object.fromEntries(Object.entries(routedJobs)
      .map(([job, output]) => [job, needs.changes.outputs[output] === "true"])),
  } : null;
  if (!expected) return [`unknown gate: ${mode}`];
  return Object.entries(expected).flatMap(([job, required]) => {
    const result = needs[job]?.result;
    return result === "success" || (!required && result === "skipped") ? [] : [`${job}: ${result ?? "missing"} (required=${required})`];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const failures = gateFailures(JSON.parse(process.env.NEEDS_JSON), process.argv[2]);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("All selected CI jobs succeeded; only unselected jobs may be skipped.");
}
