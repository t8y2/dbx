#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BUILD_GRADLE_PATH = "plugins/jdbc/build.gradle";
const MANIFEST_PATH = "plugins/jdbc/manifest.json";

function gradleVersion(buildGradle) {
  const match = buildGradle.match(/^version\s*=\s*['"]([^'"]+)['"]/m);
  return match?.[1]?.trim() ?? "";
}

function manifestVersion(manifestJson) {
  return JSON.parse(manifestJson).version ?? "";
}

function bumpPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    throw new Error(`JDBC plugin version '${version}' is not a patchable semver version.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`;
}

function isReleaseBumpRelevantJdbcPluginChange(file) {
  if (file.startsWith("plugins/jdbc/src/") || file.startsWith("plugins/jdbc/bin/")) return true;
  if (!file.startsWith("plugins/jdbc/")) return false;
  if (file.startsWith("plugins/jdbc/dist/") || file.startsWith("plugins/jdbc/target/")) return false;
  if (file === "plugins/jdbc/README.md" || file === "plugins/jdbc/package.sh") return false;
  if (file === BUILD_GRADLE_PATH || file === MANIFEST_PATH) return false;
  return true;
}

function hasJdbcPluginVersionChange(file) {
  return file === MANIFEST_PATH;
}

function updateGradleVersion(buildGradle, version) {
  return buildGradle.replace(/^(version\s*=\s*)(['"])[^'"]+\2/m, (_, prefix, quote) => `${prefix}${quote}${version}${quote}`);
}

function updateManifestVersion(manifestJson, version) {
  const manifest = JSON.parse(manifestJson);
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function evaluateJdbcPluginReleaseBump({ changedFiles, buildGradle, manifestJson }) {
  const currentGradleVersion = gradleVersion(buildGradle);
  const currentManifestVersion = manifestVersion(manifestJson);
  if (currentGradleVersion !== currentManifestVersion) {
    throw new Error(`JDBC plugin version mismatch: build.gradle is ${currentGradleVersion} but manifest.json is ${currentManifestVersion}.`);
  }

  const shouldBump = changedFiles.some(isReleaseBumpRelevantJdbcPluginChange) && !changedFiles.some(hasJdbcPluginVersionChange);
  const newVersion = shouldBump ? bumpPatchVersion(currentGradleVersion) : currentGradleVersion;
  return {
    changed: shouldBump,
    oldVersion: currentGradleVersion,
    newVersion,
    buildGradle: shouldBump ? updateGradleVersion(buildGradle, newVersion) : buildGradle,
    manifestJson: shouldBump ? updateManifestVersion(manifestJson, newVersion) : manifestJson,
  };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  const [baseRef = "HEAD~1", headRef = "HEAD", ...flags] = process.argv.slice(2);
  const write = flags.includes("--write");
  const changedFiles = git(["diff", "--name-only", baseRef, headRef]).split("\n").filter(Boolean);
  const result = evaluateJdbcPluginReleaseBump({
    changedFiles,
    buildGradle: readFileSync(BUILD_GRADLE_PATH, "utf8"),
    manifestJson: readFileSync(MANIFEST_PATH, "utf8"),
  });

  if (write && result.changed) {
    writeFileSync(BUILD_GRADLE_PATH, result.buildGradle);
    writeFileSync(MANIFEST_PATH, result.manifestJson);
  }

  console.log(`changed=${result.changed}`);
  console.log(`old_version=${result.oldVersion}`);
  console.log(`new_version=${result.newVersion}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
