#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const REGISTRY_ASSET = "agent-registry.json";
const NATIVE_MODULES = new Set(["duckdb", "oracle", "xugu", "kingbase", "vastbase", "rabbitmq", "tdengine"]);
const PLATFORMS = [
  "macos-aarch64",
  "macos-x64",
  "linux-aarch64",
  "linux-x64",
  "windows-aarch64",
  "windows-x64",
];

function artifactFilename(url) {
  return basename(url.split(/[?#]/, 1)[0]);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function releaseAssetMap(release) {
  return new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
}

function requireReleaseAsset(assets, artifact, context) {
  const name = artifactFilename(artifact.url);
  const releaseAsset = assets.get(name);
  if (!releaseAsset) {
    throw new Error(`${context} is missing from the previous GitHub release: ${name}`);
  }
  if (!artifact.sha256) {
    throw new Error(`${context} is missing sha256 in the previous agent registry: ${name}`);
  }
  if (releaseAsset.digest !== `sha256:${artifact.sha256}`) {
    throw new Error(`${context} digest mismatch between the registry and GitHub release: ${name}`);
  }
  return { name, sha256: artifact.sha256, size: artifact.size, releaseAsset };
}

export function collectReusableAssetPlan({ registry, release, versions, modules, reuseJre }) {
  const assets = releaseAssetMap(release);
  const driverAssets = [];
  const jreAssets = [];

  for (const moduleName of modules) {
    const driver = registry.drivers?.[moduleName];
    if (!driver) {
      throw new Error(`Previous agent registry is missing reusable module: ${moduleName}`);
    }
    if (driver.version !== versions[moduleName]) {
      throw new Error(`Previous agent version mismatch for ${moduleName}: registry=${driver.version}, expected=${versions[moduleName]}`);
    }

    const reusableJar = driver.jar && driver.jar.size > 0;
    if (reusableJar) {
      driverAssets.push({
        ...requireReleaseAsset(assets, driver.jar, `${moduleName} Java package`),
        moduleName,
        kind: "jar",
        platform: "",
      });
    }

    const nativePlatforms = Object.keys(driver.native ?? {}).sort();
    if (NATIVE_MODULES.has(moduleName)) {
      const missingPlatforms = PLATFORMS.filter((platform) => !nativePlatforms.includes(platform));
      const extraPlatforms = nativePlatforms.filter((platform) => !PLATFORMS.includes(platform));
      if (missingPlatforms.length > 0 || extraPlatforms.length > 0) {
        throw new Error(
          `Previous native artifacts are incomplete for ${moduleName}: missing=${missingPlatforms.join(",") || "none"}, extra=${extraPlatforms.join(",") || "none"}`,
        );
      }
    }

    for (const platform of nativePlatforms) {
      driverAssets.push({
        ...requireReleaseAsset(assets, driver.native[platform], `${moduleName}/${platform} native package`),
        moduleName,
        kind: "native",
        platform,
      });
    }

    if (!reusableJar && nativePlatforms.length === 0) {
      throw new Error(`Previous agent registry has no reusable artifacts for module: ${moduleName}`);
    }
  }

  if (reuseJre) {
    for (const [jreKey, jre] of Object.entries(registry.jres ?? {})) {
      const platforms = Object.keys(jre.platforms ?? {}).sort();
      const missingPlatforms = PLATFORMS.filter((platform) => !platforms.includes(platform));
      const extraPlatforms = platforms.filter((platform) => !PLATFORMS.includes(platform));
      if (missingPlatforms.length > 0 || extraPlatforms.length > 0) {
        throw new Error(
          `Previous JRE ${jreKey} artifacts are incomplete: missing=${missingPlatforms.join(",") || "none"}, extra=${extraPlatforms.join(",") || "none"}`,
        );
      }
      for (const platform of platforms) {
        jreAssets.push({
          ...requireReleaseAsset(assets, jre.platforms[platform], `JRE ${jreKey}/${platform} package`),
          jreKey,
          platform,
        });
      }
    }
    if (jreAssets.length === 0) {
      throw new Error("Previous agent registry has no reusable JRE artifacts.");
    }
  }

  return { driverAssets, jreAssets };
}

function verifyDownloadedAsset(path, asset) {
  if (!existsSync(path)) {
    throw new Error(`Downloaded release asset is missing: ${asset.name}`);
  }
  const size = statSync(path).size;
  if (asset.size != null && size !== asset.size) {
    throw new Error(`Downloaded release asset size mismatch for ${asset.name}: got=${size}, expected=${asset.size}`);
  }
  const digest = sha256(path);
  if (digest !== asset.sha256) {
    throw new Error(`Downloaded release asset SHA-256 mismatch for ${asset.name}: got=${digest}, expected=${asset.sha256}`);
  }
}

function copyWithoutConflict(source, target) {
  if (existsSync(target)) {
    if (sha256(source) !== sha256(target)) {
      throw new Error(`Reused raw artifact conflicts with an existing file: ${basename(target)}`);
    }
    return;
  }
  copyFileSync(source, target);
}

function extractRawDriver(packagePath, asset, outputDir = "") {
  const extractDir = mkdtempSync(join(tmpdir(), "dbx-agent-package-"));
  try {
    execFileSync("tar", ["--use-compress-program=unzstd", "-xf", packagePath, "-C", extractDir], { stdio: "inherit" });
    const embeddedRegistry = JSON.parse(readFileSync(join(extractDir, REGISTRY_ASSET), "utf8"));
    const driver = embeddedRegistry.drivers?.[asset.moduleName];
    if (!driver || driver.version !== asset.releaseVersion) {
      throw new Error(`Embedded registry mismatch in ${asset.name}`);
    }

    const embeddedArtifact = asset.kind === "jar" ? driver.jar : driver.native?.[asset.platform];
    if (!embeddedArtifact) {
      throw new Error(`Embedded registry artifact is missing in ${asset.name}`);
    }
    const rawName = artifactFilename(embeddedArtifact.url);
    const rawPath = join(extractDir, "drivers", rawName);
    if (!existsSync(rawPath)) {
      throw new Error(`Embedded raw driver is missing in ${asset.name}: ${rawName}`);
    }
    const rawSize = statSync(rawPath).size;
    if (embeddedArtifact.size != null && rawSize !== embeddedArtifact.size) {
      throw new Error(`Embedded raw driver size mismatch in ${asset.name}: ${rawName}`);
    }
    if (embeddedArtifact.sha256 && sha256(rawPath) !== embeddedArtifact.sha256) {
      throw new Error(`Embedded raw driver SHA-256 mismatch in ${asset.name}: ${rawName}`);
    }
    if (outputDir) {
      copyWithoutConflict(rawPath, join(outputDir, rawName));
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function extractReusableDriverPackages({ packagesDir, outputDir, versions, modules }) {
  mkdirSync(outputDir, { recursive: true });
  const filenames = new Set(readdirSync(packagesDir));
  let extracted = 0;

  for (const moduleName of modules) {
    const releaseVersion = versions[moduleName];
    if (!releaseVersion) {
      throw new Error(`Missing effective previous version for reusable module: ${moduleName}`);
    }

    const javaName = `dbx-agent-${moduleName}-${releaseVersion}.tar.zst`;
    if (filenames.has(javaName)) {
      extractRawDriver(join(packagesDir, javaName), {
        name: javaName,
        moduleName,
        kind: "jar",
        platform: "",
        releaseVersion,
      }, outputDir);
      extracted += 1;
    }

    const nativePlatforms = [];
    for (const platform of PLATFORMS) {
      const nativeName = `dbx-agent-${moduleName}-${releaseVersion}-${platform}.tar.zst`;
      if (!filenames.has(nativeName)) continue;
      nativePlatforms.push(platform);
      extractRawDriver(join(packagesDir, nativeName), {
        name: nativeName,
        moduleName,
        kind: "native",
        platform,
        releaseVersion,
      }, outputDir);
      extracted += 1;
    }

    if (NATIVE_MODULES.has(moduleName) && nativePlatforms.length !== PLATFORMS.length) {
      throw new Error(`Reusable native package set is incomplete for ${moduleName}.`);
    }
    if (!filenames.has(javaName) && nativePlatforms.length === 0) {
      throw new Error(`Reusable package is missing for module: ${moduleName}`);
    }
  }

  return extracted;
}

function gh(args, options = {}) {
  const result = execFileSync("gh", args, { encoding: "utf8", ...options });
  return typeof result === "string" ? result.trim() : "";
}

function downloadReleaseAssets(assets, downloadDir) {
  if (assets.length === 0) return;
  const args = [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "5",
    "--retry-all-errors",
    "--retry-delay",
    "2",
    "--connect-timeout",
    "30",
    "--parallel",
    "--parallel-immediate",
    "--parallel-max",
    "6",
  ];
  for (const asset of assets) {
    if (!asset.browser_download_url) {
      throw new Error(`GitHub release asset is missing browser_download_url: ${asset.name}`);
    }
    args.push("--output", join(downloadDir, asset.name), asset.browser_download_url);
  }
  execFileSync("curl", args, { stdio: "inherit" });
}

function parseArgs(argv) {
  const options = {
    repo: "",
    tag: "",
    versions: {},
    modules: [],
    reuseJre: false,
    outputDir: "",
    extractPackagesDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[++index];
    if (value == null) throw new Error(`Missing value for ${arg}`);
    if (arg === "--repo") options.repo = value;
    else if (arg === "--tag") options.tag = value;
    else if (arg === "--versions") options.versions = JSON.parse(value);
    else if (arg === "--modules") options.modules = JSON.parse(value);
    else if (arg === "--reuse-jre") options.reuseJre = value === "true";
    else if (arg === "--output") options.outputDir = value;
    else if (arg === "--extract-packages") options.extractPackagesDir = value;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  const requiredKeys = options.extractPackagesDir ? ["outputDir"] : ["repo", "tag", "outputDir"];
  for (const key of requiredKeys) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.extractPackagesDir) {
    const count = extractReusableDriverPackages({
      packagesDir: options.extractPackagesDir,
      outputDir: options.outputDir,
      versions: options.versions,
      modules: options.modules,
    });
    console.log(`Extracted ${count} reusable driver artifacts.`);
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "dbx-agent-reuse-"));
  const downloadDir = join(workDir, "downloads");
  mkdirSync(downloadDir);
  mkdirSync(options.outputDir, { recursive: true });

  try {
    const release = JSON.parse(gh(["api", `repos/${options.repo}/releases/tags/${options.tag}`]));
    const assets = releaseAssetMap(release);
    const registryReleaseAsset = assets.get(REGISTRY_ASSET);
    if (!registryReleaseAsset?.digest?.startsWith("sha256:")) {
      throw new Error(`Previous GitHub release ${options.tag} is missing a SHA-256 digest for ${REGISTRY_ASSET}.`);
    }

    downloadReleaseAssets([registryReleaseAsset], downloadDir);
    const registryPath = join(downloadDir, REGISTRY_ASSET);
    const registryDigest = registryReleaseAsset.digest.slice("sha256:".length);
    verifyDownloadedAsset(registryPath, {
      name: REGISTRY_ASSET,
      sha256: registryDigest,
      size: registryReleaseAsset.size,
    });
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const plan = collectReusableAssetPlan({
      registry,
      release,
      versions: options.versions,
      modules: options.modules,
      reuseJre: options.reuseJre,
    });
    const plannedAssets = [...plan.driverAssets, ...plan.jreAssets].map((asset) => ({
      ...asset,
      releaseVersion: options.versions[asset.moduleName],
    }));

    if (plannedAssets.length > 0) {
      downloadReleaseAssets(plannedAssets.map((asset) => asset.releaseAsset), downloadDir);
    }

    for (const asset of plannedAssets) {
      const source = join(downloadDir, asset.name);
      verifyDownloadedAsset(source, asset);
      copyFileSync(source, join(options.outputDir, asset.name));
      if (asset.moduleName) {
        extractRawDriver(source, asset);
      }
    }

    const outputNames = readdirSync(options.outputDir).sort();
    console.log(`Reused ${plan.driverAssets.length} driver packages and ${plan.jreAssets.length} JRE packages from ${options.tag}.`);
    console.log(outputNames.join("\n"));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
