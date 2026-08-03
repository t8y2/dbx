#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const VERSIONS_PATH = "agents/versions.json";
const VERSION_SYNC_SUBJECT = "chore: bump module versions [skip ci]";
const JRE_BUILD_PATHS = new Set([".github/workflows/agents-release.yml"]);

function bumpPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (!match) {
    throw new Error(`Agent version '${version}' is not a patchable semver version.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`;
}

function pathChanged(changedFiles, pathPrefix) {
  const normalized = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  return changedFiles.some((file) => (file === pathPrefix || file.startsWith(normalized)) && isAgentPublishRelevantFile(file));
}

export function isAgentPublishRelevantFile(file) {
  return !file.endsWith("_test.go") && !file.includes("/src/test/") && !file.includes("/bench/");
}

function isCommonRuntimeChange(file) {
  return file === "agents/common/build.gradle" || file.startsWith("agents/common/src/main/");
}

export function parseLegacyStandaloneProjects(buildGradle) {
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

const nativeDriverDirectories = {
  duckdb: "duckdb",
  oracle: "oracle-go",
  kingbase: "kingbase-go",
  rabbitmq: "rabbitmq",
};
const nativeDriverModules = new Set(["duckdb", "oracle", "xugu", "kingbase", "rabbitmq"]);

function resolveAgentModule(moduleName, { legacyStandaloneModules, moduleExists, readModuleFile }) {
  let checkDir = null;
  const nativeDriverDirectory = nativeDriverDirectories[moduleName];
  if (nativeDriverDirectory && moduleExists(`agents/drivers/${nativeDriverDirectory}`)) {
    checkDir = `drivers/${nativeDriverDirectory}`;
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
    javaBuild: hasBuildGradle,
    nativeBuild: nativeDriverModules.has(moduleName),
    commonDependent: hasBuildGradle && (explicitlyDependsOnCommon || !legacyStandaloneModules.has(moduleName)),
  };
}

function classifyModules(versions, options) {
  return Object.keys(versions)
    .map((moduleName) => ({ moduleName, module: resolveAgentModule(moduleName, options) }))
    .filter(({ module }) => module);
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
  const changedModules = [];
  const javaModules = [];
  const nativeModules = [];
  const reusedModules = [];
  const resolvedModules = classifyModules(versions, { legacyStandaloneModules, moduleExists, readModuleFile });

  if (manualVersionsChanged && !skipBump) {
    logs.push("Manual agents/versions.json changes detected; preserving manually changed module versions and auto-bumping the rest.");
  }

  if (skipBump) {
    logs.push("Skipping automatic module version bump for migrated first release; versions.json was carried over from dbx-agents.");
    for (const { moduleName, module } of resolvedModules) {
      changedModules.push(moduleName);
      if (module.javaBuild) javaModules.push(moduleName);
      if (module.nativeBuild) nativeModules.push(moduleName);
    }
    return { changed, versions: nextVersions, prevVersions, logs, changedModules, javaModules, nativeModules, reusedModules };
  }

  const commonChanged = changedFiles.some(isCommonRuntimeChange);
  if (commonChanged) {
    logs.push("Common agent runtime changes detected; common-triggered bumps are limited to modules that package agents/common.");
  }

  for (const { moduleName, module } of resolvedModules) {
    const moduleChanged = pathChanged(changedFiles, module.modulePath);
    // Only modules that package agents/common need installer-visible updates
    // for shared Java runtime changes; native and standalone agents do not.
    const commonAffectsModule = commonChanged && module.commonDependent;
    const oldVersion = nextVersions[moduleName] ?? "0.1.0";
    const prevVersion = prevVersions[moduleName] ?? "";
    const manuallyVersioned = manualVersionsChanged && (!prevVersion || prevVersion !== oldVersion);
    const moduleNeedsBuild = moduleChanged || commonAffectsModule || manuallyVersioned;

    if (!moduleNeedsBuild) {
      logs.push(`  ${moduleName}: no changes`);
      reusedModules.push(moduleName);
    } else if (manuallyVersioned) {
      changedModules.push(moduleName);
      if (module.javaBuild) javaModules.push(moduleName);
      if (module.nativeBuild) nativeModules.push(moduleName);
      if (!prevVersion) {
        logs.push(`  ${moduleName}: CHANGED, new module version kept at ${oldVersion}`);
      } else {
        logs.push(`  ${moduleName}: CHANGED, manual version ${prevVersion} -> ${oldVersion}`);
      }
    } else {
      changedModules.push(moduleName);
      if (module.javaBuild) javaModules.push(moduleName);
      if (module.nativeBuild) nativeModules.push(moduleName);
      const newVersion = bumpPatchVersion(oldVersion);
      nextVersions[moduleName] = newVersion;
      changed = true;
      logs.push(`  ${moduleName}: CHANGED`);
      logs.push(`  ${moduleName}: ${oldVersion} -> ${newVersion}`);
    }
  }

  return { changed, versions: nextVersions, prevVersions, logs, changedModules, javaModules, nativeModules, reusedModules };
}

export function getAgentVersionChanges(previousVersions, nextVersions) {
  return Object.keys(nextVersions)
    .filter((moduleName) => nextVersions[moduleName] !== previousVersions[moduleName])
    .map((moduleName) => ({
      moduleName,
      previousVersion: previousVersions[moduleName] ?? null,
      nextVersion: nextVersions[moduleName],
    }));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function resolveAgentReleaseBaseline({ prevTag, headRef = "HEAD", gitOutput = git }) {
  const allChangedFiles = lines(gitOutput(["diff", "--name-only", `${prevTag}..${headRef}`]));
  const versionCommits = lines(
    gitOutput([
      "log",
      "--reverse",
      "--ancestry-path",
      "--format=%H%x09%s",
      `${prevTag}..${headRef}`,
      "--",
      VERSIONS_PATH,
    ]),
  );

  let syncCommit = "";
  for (const entry of versionCommits) {
    const separator = entry.indexOf("\t");
    if (separator < 0 || entry.slice(separator + 1) !== VERSION_SYNC_SUBJECT) continue;

    const commit = entry.slice(0, separator);
    const changedPaths = lines(gitOutput(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]));
    if (changedPaths.length !== 1 || changedPaths[0] !== VERSIONS_PATH) continue;

    JSON.parse(gitOutput(["show", `${commit}:${VERSIONS_PATH}`]));
    syncCommit = commit;
    break;
  }

  const versionsRef = syncCommit || prevTag;
  const versions = JSON.parse(gitOutput(["show", `${versionsRef}:${VERSIONS_PATH}`]));
  const versionsChangedAfterSync = syncCommit
    ? lines(gitOutput(["log", "--format=%H", `${syncCommit}..${headRef}`, "--", VERSIONS_PATH])).length > 0
    : false;
  const changedFiles = syncCommit && !versionsChangedAfterSync
    ? allChangedFiles.filter((file) => file !== VERSIONS_PATH)
    : allChangedFiles;

  return {
    prevTag,
    versionsRef,
    syncCommit,
    versions,
    changedFiles,
    allChangedFiles,
    versionsChangedAfterSync,
  };
}

export function shouldBuildAgentJre(changedFiles, migratedFirstRelease = false) {
  return migratedFirstRelease || changedFiles.some((file) => JRE_BUILD_PATHS.has(file));
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

function outputStepValues(result, baseline, migratedFirstRelease, buildJre) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  appendFileSync(
    outputPath,
    [
      `versions=${JSON.stringify(result.versions)}`,
      `prev_versions=${JSON.stringify(result.prevVersions)}`,
      `prev_tag=${baseline.prevTag}`,
      `effective_prev_ref=${baseline.versionsRef}`,
      `changed_modules=${JSON.stringify(result.changedModules)}`,
      `java_modules=${JSON.stringify(result.javaModules)}`,
      `native_modules=${JSON.stringify(result.nativeModules)}`,
      `reuse_modules=${JSON.stringify(migratedFirstRelease ? [] : result.reusedModules)}`,
      `build_jre=${buildJre}`,
      `reuse_jre=${!migratedFirstRelease && !buildJre}`,
      `migrated_first_release=${migratedFirstRelease}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));
  const legacyStandaloneModules = parseLegacyStandaloneProjects(readFileSync("agents/build.gradle", "utf8"));
  const baseline = options.prevVersionsFile
    ? {
        prevTag: options.prevTag,
        versionsRef: options.prevTag,
        syncCommit: "",
        versions: JSON.parse(readFileSync(options.prevVersionsFile, "utf8")),
        changedFiles: lines(git(["diff", "--name-only", `${options.prevTag}..HEAD`])),
      }
    : resolveAgentReleaseBaseline({ prevTag: options.prevTag });
  const changedFiles = options.skipBump ? [] : baseline.changedFiles;
  const manualVersionsChanged = changedFiles.includes(VERSIONS_PATH);
  const prevVersions = baseline.versions;

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
  const buildJre = shouldBuildAgentJre(baseline.changedFiles, options.migratedFirstRelease);
  outputStepValues(result, baseline, options.migratedFirstRelease, buildJre);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
