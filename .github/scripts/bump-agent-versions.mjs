#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const VERSIONS_PATH = "agents/versions.json";

function bumpPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!match) {
    throw new Error(`Agent version '${version}' is not a patchable semver version.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`;
}

function pathChanged(changedFiles, pathPrefix) {
  const normalized = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  return changedFiles.some((file) => file === pathPrefix || file.startsWith(normalized));
}

function isCommonRuntimeChange(file) {
  return file === "agents/common/build.gradle" || file.startsWith("agents/common/src/main/");
}

function parseLegacyStandaloneProjects(buildGradle) {
  const match = /legacyStandaloneProjects\s*=\s*\[([^\]]*)\]/m.exec(buildGradle);
  if (!match) return new Set();

  return new Set(
    [...match[1].matchAll(/['"]([^'"]+)['"]/g)]
      .map((entry) => entry[1])
      .filter(Boolean),
  );
}

function fileContainsCommonDependency(path, moduleExists, readModuleFile) {
  if (!moduleExists(path)) return false;
  const source = readModuleFile(path);
  return /project\(\s*['"]:common['"]\s*\)/.test(source);
}

function resolveAgentModule(moduleName, { legacyStandaloneModules, moduleExists, readModuleFile }) {
  let checkDir = null;
  if (moduleName === "oracle" && moduleExists("agents/drivers/oracle-go")) {
    checkDir = "drivers/oracle-go";
  } else if (moduleExists(`agents/drivers/${moduleName}`)) {
    checkDir = `drivers/${moduleName}`;
  } else if (moduleExists(`agents/${moduleName}`) || moduleName === "common") {
    checkDir = moduleName;
  }

  if (!checkDir) return null;

  const modulePath = `agents/${checkDir}`;
  const buildGradlePath = `${modulePath}/build.gradle`;
  const hasBuildGradle = moduleExists(buildGradlePath);
  const explicitlyDependsOnCommon = fileContainsCommonDependency(buildGradlePath, moduleExists, readModuleFile);

  return {
    checkDir,
    modulePath,
    commonDependent: hasBuildGradle && (explicitlyDependsOnCommon || !legacyStandaloneModules.has(moduleName)),
  };
}

export function evaluateAgentVersionBump({
  versions,
  prevVersions = versions,
  changedFiles,
  legacyStandaloneModules = new Set(),
  moduleExists = existsSync,
  readModuleFile = (path) => readFileSync(path, "utf8"),
  skipBump = false,
  manualVersionsChanged = changedFiles.includes(VERSIONS_PATH),
}) {
  const nextVersions = { ...versions };
  const logs = [];
  let changed = false;

  if (manualVersionsChanged && !skipBump) {
    logs.push("Manual agents/versions.json changes detected; preserving manually changed module versions and auto-bumping the rest.");
  }

  if (skipBump) {
    logs.push("Skipping automatic module version bump for migrated first release; versions.json was carried over from dbx-agents.");
    return { changed, versions: nextVersions, prevVersions, logs };
  }

  const commonChanged = changedFiles.some(isCommonRuntimeChange);
  if (commonChanged) {
    logs.push("Common agent runtime changes detected; common-triggered bumps are limited to modules that package agents/common.");
  }

  for (const moduleName of Object.keys(versions)) {
    const module = resolveAgentModule(moduleName, { legacyStandaloneModules, moduleExists, readModuleFile });
    if (!module) continue;

    const moduleChanged = pathChanged(changedFiles, module.modulePath);
    // Only modules that package agents/common need installer-visible updates
    // for shared Java runtime changes; native and standalone agents do not.
    const commonAffectsModule = commonChanged && module.commonDependent;
    const oldVersion = nextVersions[moduleName] ?? "0.1.0";
    const prevVersion = prevVersions[moduleName] ?? "";
    const manuallyVersioned = manualVersionsChanged && (!prevVersion || prevVersion !== oldVersion);

    if (!moduleChanged && !commonAffectsModule) {
      logs.push(`  ${moduleName}: no changes`);
    } else if (manuallyVersioned) {
      if (!prevVersion) {
        logs.push(`  ${moduleName}: CHANGED, new module version kept at ${oldVersion}`);
      } else {
        logs.push(`  ${moduleName}: CHANGED, manual version ${prevVersion} -> ${oldVersion}`);
      }
    } else {
      const newVersion = bumpPatchVersion(oldVersion);
      nextVersions[moduleName] = newVersion;
      changed = true;
      logs.push(`  ${moduleName}: CHANGED`);
      logs.push(`  ${moduleName}: ${oldVersion} -> ${newVersion}`);
    }
  }

  return { changed, versions: nextVersions, prevVersions, logs };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const options = {
    migratedFirstRelease: false,
    prevTag: "",
    prevVersionsFile: "",
    skipBump: false,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--skip-bump") {
      options.skipBump = true;
    } else if (arg === "--prev-tag") {
      options.prevTag = argv[++index] ?? "";
    } else if (arg === "--prev-versions-file") {
      options.prevVersionsFile = argv[++index] ?? "";
    } else if (arg === "--migrated-first-release") {
      options.migratedFirstRelease = (argv[++index] ?? "") === "true";
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.prevTag) {
    throw new Error("--prev-tag is required.");
  }
  return options;
}

function outputStepValues(result, prevTag, migratedFirstRelease) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  appendFileSync(
    outputPath,
    [
      `versions=${JSON.stringify(result.versions)}`,
      `prev_versions=${JSON.stringify(result.prevVersions)}`,
      `prev_tag=${prevTag}`,
      `migrated_first_release=${migratedFirstRelease}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));
  const legacyStandaloneModules = parseLegacyStandaloneProjects(readFileSync("agents/build.gradle", "utf8"));
  const changedFiles = options.skipBump ? [] : git(["diff", "--name-only", `${options.prevTag}..HEAD`]).split("\n").filter(Boolean);
  const manualVersionsChanged = changedFiles.includes(VERSIONS_PATH);
  const prevVersions = options.prevVersionsFile
    ? JSON.parse(readFileSync(options.prevVersionsFile, "utf8"))
    : manualVersionsChanged
      ? JSON.parse(git(["show", `${options.prevTag}:${VERSIONS_PATH}`]))
      : versions;

  const result = evaluateAgentVersionBump({
    versions,
    prevVersions,
    changedFiles,
    legacyStandaloneModules,
    skipBump: options.skipBump,
    manualVersionsChanged,
  });

  for (const line of result.logs) {
    console.log(line);
  }

  const versionsJson = `${JSON.stringify(result.versions, null, 2)}\n`;
  if (options.write) {
    writeFileSync(VERSIONS_PATH, versionsJson);
  }
  console.log(versionsJson);
  outputStepValues(result, options.prevTag, options.migratedFirstRelease);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
