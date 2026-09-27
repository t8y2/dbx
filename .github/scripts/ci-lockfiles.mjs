import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function lockfileManifests(plan) {
  return [...(plan.rust ? ["Cargo.toml"] : []),
    ...plan.agent_rust.include.map(({ driver }) => {
      if (!["duckdb", "tdengine"].includes(driver)) throw new Error(`Unknown native Rust driver: ${driver}`);
      return `agents/drivers/${driver}/Cargo.toml`;
    })];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const plan = JSON.parse(process.env.CI_PLAN);
  for (const manifest of lockfileManifests(plan)) {
    console.log(`Checking locked dependency resolution: ${manifest}`);
    const result = spawnSync("cargo", ["metadata", "--locked", "--manifest-path", manifest, "--format-version", "1"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
