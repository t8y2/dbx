import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rustGroups } from "./ci-config.mjs";

export function rustCommand(action, group, mode) {
  if (!["test", "doctest", "clippy", "tree"].includes(action) || !["full", "fast"].includes(mode)
    || (group !== "workspace" && !Object.hasOwn(rustGroups, group)) || (action === "clippy" && group !== "workspace")) {
    throw new Error(`Unknown Rust CI configuration: ${action}/${group}/${mode}`);
  }
  const capabilityFeatures = ["duckdb-sidecar", "dynamodb", "mq-admin", "sqlite-sqlcipher"];
  if (mode === "full") capabilityFeatures.push("system-fonts");
  const appFeatures = ["dbx", "dbx-core", "dbx-web"].flatMap((name) => capabilityFeatures.map((feature) => `${name}/${feature}`));
  const foundationFeatures = ["dbx-types/mq-admin", "dbx-types/openapi", "dbx-sql/duckdb-sidecar", "dbx-sql/openapi",
    "dbx-platform/downloads", "dbx-platform/host-prompts", "dbx-platform/test-support", "dbx-plugin-runtime/default", "dbx-plugin-runtime/test-support"];
  const features = group === "foundation" ? foundationFeatures : group === "drivers" ? [
    ...["duckdb-sidecar", "dynamodb", "mq-admin", "sqlite-bundled", "sqlite-sqlcipher", "test-support"].map((feature) => `dbx-drivers/${feature}`),
    "dbx-sqlite-worker/runtime", "dbx-types/openapi", "dbx-sql/openapi",
  ] : appFeatures;
  const packages = group === "workspace" ? ["--workspace"] : rustGroups[group].flatMap((name) => ["--package", name]);
  const command = action === "test" ? ["nextest", "run", "--no-fail-fast"] : action === "doctest" ? ["test", "--doc"] : [action];
  return [...command, ...packages, "--locked", ...(action === "clippy" ? ["--all-targets"] : []),
    "--no-default-features", "--features", features.join(","), ...(action === "clippy" ? ["--", "-D", "warnings"] : [])];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = rustCommand(...process.argv.slice(2, 5));
  console.log(`cargo ${args.join(" ")}`);
  const result = spawnSync("cargo", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
