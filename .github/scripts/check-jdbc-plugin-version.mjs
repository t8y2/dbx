#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const POM_PATH = "plugins/jdbc/pom.xml";
const MANIFEST_PATH = "plugins/jdbc/manifest.json";

function firstProjectVersion(pomXml) {
  const match = pomXml.match(/<project[\s\S]*?<version>([^<]+)<\/version>/);
  return match?.[1]?.trim() ?? "";
}

function manifestVersion(manifestJson) {
  return JSON.parse(manifestJson).version ?? "";
}

export function evaluateJdbcPluginVersionChange({ headPomVersion, headManifestVersion }) {
  const errors = [];
  if (headPomVersion !== headManifestVersion) {
    errors.push(`JDBC plugin version mismatch: pom.xml is ${headPomVersion} but manifest.json is ${headManifestVersion}.`);
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
  const headPomVersion = firstProjectVersion(readFileAt(headRef, POM_PATH));
  const headManifestVersion = manifestVersion(readFileAt(headRef, MANIFEST_PATH));
  const errors = evaluateJdbcPluginVersionChange({
    headPomVersion,
    headManifestVersion,
  });

  if (errors.length) {
    for (const error of errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }
  console.log(`JDBC plugin version check passed (${headPomVersion}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
