#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const BUILD_GRADLE_PATH = "plugins/jdbc/build.gradle";
const MANIFEST_PATH = "plugins/jdbc/manifest.json";

export function jdbcGradleVersion(buildGradle) {
  const match = buildGradle.match(/^version\s*=\s*['"]([^'"]+)['"]/m);
  return match?.[1]?.trim() ?? "";
}

function manifestVersion(manifestJson) {
  return JSON.parse(manifestJson).version ?? "";
}

export function evaluateJdbcPluginVersionChange({ headGradleVersion, headManifestVersion }) {
  const errors = [];
  if (headGradleVersion !== headManifestVersion) {
    errors.push(`JDBC plugin version mismatch: build.gradle is ${headGradleVersion} but manifest.json is ${headManifestVersion}.`);
    return errors;
  }
  return errors;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function readFileAt(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

function main() {
  const [, headRef = "HEAD"] = process.argv.slice(2);
  const headGradleVersion = jdbcGradleVersion(readFileAt(headRef, BUILD_GRADLE_PATH));
  const headManifestVersion = manifestVersion(readFileAt(headRef, MANIFEST_PATH));
  const errors = evaluateJdbcPluginVersionChange({
    headGradleVersion,
    headManifestVersion,
  });

  if (errors.length) {
    for (const error of errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }
  console.log(`JDBC plugin version check passed (${headGradleVersion}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
