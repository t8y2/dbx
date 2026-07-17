#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const POM_PATH = "plugins/jdbc/pom.xml";
const MANIFEST_PATH = "plugins/jdbc/manifest.json";

function firstProjectVersion(pomXml) {
  const match = pomXml.match(/<project[\s\S]*?<version>([^<]+)<\/version>/);
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
  if (file === POM_PATH || file === MANIFEST_PATH) return false;
  return true;
}

function hasJdbcPluginVersionChange(file) {
  return file === POM_PATH || file === MANIFEST_PATH;
}

function updatePomVersion(pomXml, version) {
  return pomXml.replace(/(<project[\s\S]*?<version>)([^<]+)(<\/version>)/, `$1${version}$3`);
}

function updateManifestVersion(manifestJson, version) {
  const manifest = JSON.parse(manifestJson);
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function evaluateJdbcPluginReleaseBump({ changedFiles, pomXml, manifestJson }) {
  const pomVersion = firstProjectVersion(pomXml);
  const currentManifestVersion = manifestVersion(manifestJson);
  if (pomVersion !== currentManifestVersion) {
    throw new Error(`JDBC plugin version mismatch: pom.xml is ${pomVersion} but manifest.json is ${currentManifestVersion}.`);
  }

  const shouldBump = changedFiles.some(isReleaseBumpRelevantJdbcPluginChange) && !changedFiles.some(hasJdbcPluginVersionChange);
  const newVersion = shouldBump ? bumpPatchVersion(pomVersion) : pomVersion;
  return {
    changed: shouldBump,
    oldVersion: pomVersion,
    newVersion,
    pomXml: shouldBump ? updatePomVersion(pomXml, newVersion) : pomXml,
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
    pomXml: readFileSync(POM_PATH, "utf8"),
    manifestJson: readFileSync(MANIFEST_PATH, "utf8"),
  });

  if (write && result.changed) {
    writeFileSync(POM_PATH, result.pomXml);
    writeFileSync(MANIFEST_PATH, result.manifestJson);
  }

  console.log(`changed=${result.changed}`);
  console.log(`old_version=${result.oldVersion}`);
  console.log(`new_version=${result.newVersion}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
