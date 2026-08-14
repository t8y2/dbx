#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const BUNDLES = [
  "io.prestosql:presto-jdbc:350",
  "org.apache.phoenix:phoenix-client-embedded-hbase-2.5:5.2.1",
  "ch.qos.reload4j:reload4j:1.2.26",
  "org.apache.phoenix:phoenix-queryserver-client:6.0.0",
];
const MAVEN_CENTRAL = "https://repo.maven.apache.org/maven2/";

function fail(message) {
  throw new Error(message);
}

function bundleId(coordinate) {
  const id = coordinate.trim().replace(/[^A-Za-z0-9.-]/g, "_");
  return id || "maven-driver";
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function uniqueFileName(directory, requested) {
  if (!existsSync(join(directory, requested))) return requested;
  const dot = requested.lastIndexOf(".");
  const stem = dot > 0 ? requested.slice(0, dot) : requested;
  const extension = dot > 0 ? requested.slice(dot) : "";
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existsSync(join(directory, candidate))) return candidate;
  }
}

function resolveBundle(resolver, coordinate, localRepository, repository) {
  const javaToolOptions = [
    process.env.JAVA_TOOL_OPTIONS,
    "-Djava.net.preferIPv4Stack=true",
    "-Daether.connector.connectTimeout=30000",
    "-Daether.connector.requestTimeout=300000",
  ]
    .filter(Boolean)
    .join(" ");
  const result = spawnSync(
    resolver,
    ["resolve", "--coordinate", coordinate, "--local-repo", localRepository, "--repo", repository],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, JAVA_TOOL_OPTIONS: javaToolOptions } },
  );
  if (result.error) fail(`Failed to start JDBC Maven resolver for ${coordinate}: ${result.error.message}`);
  if (result.status !== 0) fail(`Failed to resolve ${coordinate}: ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Failed to parse Maven resolver output for ${coordinate}: ${error.message}`);
  }
}

async function main() {
  const [releaseArg, pluginZipArg, resolverArg] = process.argv.slice(2);
  if (!releaseArg || !pluginZipArg || !resolverArg) {
    fail("Usage: build_offline_jdbc_payload.mjs <release-dir> <jdbc-plugin-zip> <maven-resolver>");
  }

  const releaseDir = resolve(releaseArg);
  const pluginZip = resolve(pluginZipArg);
  const resolver = resolve(resolverArg);
  if (!existsSync(pluginZip)) fail(`JDBC plugin ZIP not found: ${pluginZip}`);
  if (!existsSync(resolver)) fail(`JDBC Maven resolver not found: ${resolver}`);

  const payloadDir = join(releaseDir, "offline-jdbc", "jdbc");
  const mavenDir = join(payloadDir, "maven");
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(mavenDir, { recursive: true });
  copyFileSync(pluginZip, join(payloadDir, "plugin.zip"));

  const externalCache = process.env.DBX_OFFLINE_JDBC_MAVEN_CACHE?.trim();
  const repository = process.env.DBX_OFFLINE_JDBC_MAVEN_REPOSITORY?.trim() || MAVEN_CENTRAL;
  const workDir = externalCache ? null : mkdtempSync(join(tmpdir(), "dbx-offline-jdbc-"));
  const localRepository = externalCache ? resolve(externalCache) : join(workDir, "maven-cache");
  mkdirSync(localRepository, { recursive: true });
  const manifestBundles = [];
  try {
    for (const coordinate of BUNDLES) {
      console.log(`Resolving offline JDBC bundle ${coordinate}`);
      const resolved = resolveBundle(resolver, coordinate, localRepository, repository);
      const id = bundleId(coordinate);
      const jarsDir = join(mavenDir, id, "jars");
      mkdirSync(jarsDir, { recursive: true });

      const artifacts = [];
      for (const artifact of resolved.artifacts || []) {
        if (String(artifact.extension).toLowerCase() !== "jar") continue;
        if (!existsSync(artifact.file)) fail(`Resolved artifact does not exist: ${artifact.file}`);
        const fileName = uniqueFileName(jarsDir, basename(artifact.file));
        const target = join(jarsDir, fileName);
        copyFileSync(artifact.file, target);
        const size = statSync(target).size;
        const digest = await sha256(target);
        if (Number(artifact.size) !== size || String(artifact.sha256).toLowerCase() !== digest) {
          fail(`Resolved artifact metadata mismatch: ${artifact.file}`);
        }
        artifacts.push({
          group_id: artifact.groupId,
          artifact_id: artifact.artifactId,
          version: artifact.version,
          classifier: artifact.classifier || "",
          extension: artifact.extension,
          file_name: fileName,
          path: "",
          size,
          sha256: digest,
        });
      }
      if (artifacts.length === 0) fail(`Maven resolver returned no JAR artifacts for ${coordinate}`);

      const bundleManifest = {
        id,
        coordinate,
        scope: resolved.scope || "runtime",
        repositories: resolved.repositories?.length ? resolved.repositories : [repository],
        installed_at: "",
        path: "",
        artifacts,
      };
      writeFileSync(join(mavenDir, id, "manifest.json"), `${JSON.stringify(bundleManifest, null, 2)}\n`);
      manifestBundles.push({ id, coordinate });
      console.log(`Prepared ${coordinate} (${artifacts.length} JARs)`);
    }
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }

  writeFileSync(
    join(payloadDir, "offline-manifest.json"),
    `${JSON.stringify({ format_version: 1, plugin_entry: "jdbc/plugin.zip", bundles: manifestBundles }, null, 2)}\n`,
  );
  console.log(`Prepared offline JDBC payload in ${payloadDir}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
