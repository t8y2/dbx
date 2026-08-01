#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const DATABASE_LABEL_PREFIX = "db/";
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

export const STATIC_LABEL_SPECS = {
  bug: { color: "d73a4a", description: "Fixes a bug" },
  enhancement: { color: "a2eeef", description: "Adds or improves functionality" },
  documentation: { color: "0075ca", description: "Documentation-only change" },
  maintenance: { color: "ededed", description: "Maintenance, refactoring, build, CI, or test change" },
  "area/desktop": { color: "1d76db", description: "Desktop application or Tauri shell" },
  "area/core": { color: "5319e7", description: "Shared DBX core runtime" },
  "area/web": { color: "0e8a16", description: "Web backend or web API" },
  "area/agents": { color: "f9d0c4", description: "Database agents and agent runtime" },
  "area/mcp": { color: "c2e0c6", description: "MCP server or packages" },
  "area/cli": { color: "bfd4f2", description: "DBX command-line interface" },
  "area/plugins": { color: "d4c5f9", description: "Dialect, JDBC, or mapping plugins" },
  "area/docs": { color: "0075ca", description: "Documentation site or repository documentation" },
  "area/ci": { color: "e99695", description: "GitHub Actions or repository automation" },
  "area/deploy": { color: "fef2c0", description: "Deployment, packaging, or distribution" },
  "area/multiple": { color: "ededed", description: "Touches more than three repository areas" },
  "db/multiple": { color: "ededed", description: "Touches more than three database integrations" },
  "ui-change": { color: "f9d0c4", description: "Changes user-visible interface, text, or visual assets" },
  "dependencies/frontend": { color: "fbca04", description: "Adds a frontend dependency" },
  "dependencies/backend": { color: "c2e0c6", description: "Adds a backend dependency" },
  "tests-only": { color: "bfd4f2", description: "Changes only tests, fixtures, or snapshots" },
};

const TYPE_LABELS = new Set(["bug", "enhancement", "documentation", "maintenance"]);
const LABEL_PALETTE = [
  "0e8a16",
  "1d76db",
  "5319e7",
  "c2e0c6",
  "bfd4f2",
  "d4c5f9",
  "fef2c0",
  "fbca04",
  "f9d0c4",
  "e99695",
  "f29513",
  "c5def5",
];

const DRIVER_DATABASE_ALIASES = {
  gbase8a: "gbase",
  gbase8s: "gbase",
  "h2-legacy": "h2",
  kafka: "mq",
  "kingbase-go": "kingbase",
  "oracle-10g": "oracle",
  "oracle-go": "oracle",
  "oracle-legacy": "oracle",
  rabbitmq: "mq",
  rocketmq: "mq",
  "sqlserver-legacy": "sqlserver",
};

const DIALECT_DATABASE_ALIASES = {
  oceanbase: "oceanbase-oracle",
  postgresql: "postgres",
  turso: "sqlite",
};

const DATABASE_PATH_TOKENS = [
  [/clickhouse/i, "clickhouse"],
  [/doris/i, "doris"],
  [/duckdb/i, "duckdb"],
  [/jdbc[x]?/i, "jdbc"],
  [/mongo(?:db)?/i, "mongodb"],
  [/mysql/i, "mysql"],
  [/oracle/i, "oracle"],
  [/postgres(?:ql)?/i, "postgres"],
  [/redis/i, "redis"],
  [/sqlite/i, "sqlite"],
  [/sqlserver/i, "sqlserver"],
];

const PACKAGE_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function stablePaletteColor(value) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return LABEL_PALETTE[hash % LABEL_PALETTE.length];
}

function normalizeChangedFiles(changedFiles) {
  return [...new Set(changedFiles.map((file) => String(file).replaceAll("\\", "/")).filter(Boolean))].sort();
}

function conventionalType(title) {
  const normalized = String(title || "").trim().replace(/^[^\p{L}\p{N}]+/u, "");
  return /^([a-z]+)(?:\([^)]*\))?!?[:：]/i.exec(normalized)?.[1]?.toLowerCase() || null;
}

export function isDocumentationFile(file) {
  return file.startsWith("docs/")
    || /(^|\/)README(?:\.[^/]+)?\.md$/i.test(file)
    || /(^|\/)(SECURITY|CONTRIBUTING|CODE_OF_CONDUCT)\.md$/i.test(file);
}

export function inferTypeLabel(title, changedFiles) {
  const type = conventionalType(title);
  if (type === "fix") return "bug";
  if (type === "feat") return "enhancement";
  if (type === "docs") return "documentation";
  if (["build", "chore", "ci", "perf", "refactor", "style", "test"].includes(type)) return "maintenance";
  if (changedFiles.length > 0 && changedFiles.every(isDocumentationFile)) return "documentation";
  return null;
}

export function inferAreaLabels(changedFiles) {
  const labels = new Set();
  const has = (predicate) => changedFiles.some(predicate);

  if (has((file) => file === "package.json"
    || file.startsWith("apps/desktop/")
    || file.startsWith("packages/app-tests/")
    || file.startsWith("src-tauri/"))) {
    labels.add("area/desktop");
  }
  if (has((file) => file.startsWith("crates/dbx-core/") || file.startsWith("packages/node-core/"))) {
    labels.add("area/core");
  }
  if (has((file) => file.startsWith("crates/dbx-web/") || file.startsWith("examples/web-api/"))) {
    labels.add("area/web");
  }
  if (has((file) => file.startsWith("agents/"))) labels.add("area/agents");
  if (has((file) => file.startsWith("crates/dbx-mcp/")
    || file.startsWith("packages/mcp-")
    || file.startsWith("packages/mcp-server/")
    || file.startsWith("examples/mcp/"))) {
    labels.add("area/mcp");
  }
  if (has((file) => file.startsWith("crates/dbx-cli/")
    || file.startsWith("packages/cli-")
    || file.startsWith("packages/cli/")
    || file.startsWith("examples/cli/"))) {
    labels.add("area/cli");
  }
  if (has((file) => file.startsWith("plugins/"))) labels.add("area/plugins");
  if (has(isDocumentationFile)) labels.add("area/docs");
  if (has((file) => file.startsWith(".github/"))) labels.add("area/ci");
  if (has((file) => file.startsWith("deploy/")
    || file === "flake.nix"
    || file === "flake.lock"
    || file === "Makefile"
    || /^packages\/(?:cli|mcp)-(?:darwin|linux|win32)-/.test(file))) {
    labels.add("area/deploy");
  }

  return [...labels].sort();
}

function isVisualAsset(file) {
  return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf)$/i.test(file);
}

export function isUiChangeFile(file) {
  if (isTestFile(file)) return false;

  if (file.startsWith("apps/desktop/")) {
    return /\.(?:vue|css|less|sass|scss|styl)$/i.test(file)
      || file.startsWith("apps/desktop/src/components/")
      || file.startsWith("apps/desktop/src/i18n/")
      || file.startsWith("apps/desktop/src/styles/")
      || file.startsWith("apps/desktop/public/")
      || isVisualAsset(file);
  }

  if (file.startsWith("src-tauri/icons/")) return true;

  if (file.startsWith("docs/")) {
    return /\.(?:css|jsx|tsx)$/i.test(file)
      || file.startsWith("docs/components/")
      || (file.startsWith("docs/public/") && isVisualAsset(file));
  }

  return false;
}

export function isTestFile(file) {
  return /(^|\/)(?:__tests__|fixtures|snapshots|test|tests|test-support)(\/|$)/.test(file)
    || /\.(?:spec|test)\.[^/]+$/i.test(file)
    || /(^|\/)packages\/app-tests\//.test(file);
}

function normalizeDatabaseType(value, aliases) {
  const normalized = String(value || "").toLowerCase();
  return aliases[normalized] || normalized;
}

export function inferDatabaseTypes(changedFiles, knownDatabaseTypes) {
  const databaseTypes = new Set();

  const add = (value) => {
    if (knownDatabaseTypes.has(value)) databaseTypes.add(value);
  };

  for (const file of changedFiles) {
    const driverMatch = /^agents\/drivers\/([^/]+)\//.exec(file);
    if (driverMatch) add(normalizeDatabaseType(driverMatch[1], DRIVER_DATABASE_ALIASES));

    const dialectMatch = /^plugins\/dialects\/([^/]+)\.ya?ml$/i.exec(file);
    if (dialectMatch) add(normalizeDatabaseType(dialectMatch[1], DIALECT_DATABASE_ALIASES));

    if (file.startsWith("plugins/jdbc/")) add("jdbc");

    if (file.startsWith("apps/desktop/src/") || file.startsWith("crates/dbx-core/src/")) {
      for (const [pattern, databaseType] of DATABASE_PATH_TOKENS) {
        if (pattern.test(file)) add(databaseType);
      }
    }
  }

  return [...databaseTypes].sort();
}

export function parsePackageDependencyNames(source) {
  if (!source) return new Set();
  const manifest = JSON.parse(source);
  const names = new Set();
  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return names;
}

function unquoteTomlKey(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseCargoDependencyNames(source) {
  const names = new Set();
  let dependencySection = false;

  for (const line of String(source || "").split(/\r?\n/)) {
    const sectionMatch = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      const dependencyMatch = /(?:^|\.)(?:dev-|build-)?dependencies(?:\.(.+))?$/.exec(section);
      dependencySection = Boolean(dependencyMatch && !dependencyMatch[1]);
      if (dependencyMatch?.[1]) names.add(unquoteTomlKey(dependencyMatch[1].split(".")[0]));
      continue;
    }

    if (!dependencySection || /^\s*(?:#|$)/.test(line)) continue;
    const keyMatch = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=/.exec(line);
    const name = keyMatch?.[1] || keyMatch?.[2] || keyMatch?.[3];
    if (name) names.add(name);
  }

  return names;
}

function normalizeGradleDependency(value) {
  const coordinate = String(value || "").trim();
  if (!coordinate) return null;
  if (coordinate.startsWith(":")) return `project:${coordinate}`;
  const parts = coordinate.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : coordinate;
}

export function parseGradleDependencyNames(source) {
  const names = new Set();
  const configuration = /^(?:api|annotationProcessor|classpath|compileOnly|implementation|kapt|ksp|runtimeOnly|testCompileOnly|testImplementation|testRuntimeOnly)$/;

  for (const line of String(source || "").split(/\r?\n/)) {
    const declaration = /^\s*([A-Za-z][A-Za-z0-9]*)\b(.*)$/.exec(line);
    if (!declaration || !configuration.test(declaration[1])) continue;
    const rest = declaration[2].replace(/\/\/.*$/, "");
    const quoted = /['"]([^'"]+)['"]/.exec(rest)?.[1];
    const catalog = /\b(libs\.[A-Za-z0-9_.-]+)/.exec(rest)?.[1];
    const name = catalog ? `catalog:${catalog}` : normalizeGradleDependency(quoted);
    if (name) names.add(name);
  }

  return names;
}

export function parseGoDependencyNames(source) {
  const names = new Set();
  let inRequireBlock = false;

  for (const line of String(source || "").split(/\r?\n/)) {
    const trimmed = line.replace(/\/\/.*$/, "").trim();
    if (trimmed === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && trimmed === ")") {
      inRequireBlock = false;
      continue;
    }

    const value = inRequireBlock ? trimmed : /^require\s+(.+)$/.exec(trimmed)?.[1];
    const moduleName = value?.split(/\s+/)[0];
    if (moduleName) names.add(moduleName);
  }

  return names;
}

export function parseMavenDependencyNames(source) {
  const names = new Set();
  for (const match of String(source || "").matchAll(/<dependency>\s*([\s\S]*?)<\/dependency>/g)) {
    const groupId = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(match[1])?.[1];
    const artifactId = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(match[1])?.[1];
    if (groupId && artifactId) names.add(`${groupId}:${artifactId}`);
  }
  return names;
}

function dependencySide(file) {
  if (file === "package.json" || file === "docs/package.json" || file === "packages/mongo-shell/package.json") {
    return "frontend";
  }
  if (/^packages\/(?:cli(?:-|\/)|mcp(?:-|server\/)).*\/package\.json$/.test(file)
    || file === "packages/cli/package.json"
    || file === "packages/mcp-server/package.json") {
    return "backend";
  }
  if (file === "Cargo.toml"
    || file.endsWith("/Cargo.toml")
    || file.endsWith("/build.gradle")
    || file.endsWith("/build.gradle.kts")
    || file.endsWith("/go.mod")
    || file.endsWith("/pom.xml")) {
    return "backend";
  }
  return null;
}

function parseDependencyNames(file, source) {
  if (file.endsWith("package.json")) return parsePackageDependencyNames(source);
  if (file === "Cargo.toml" || file.endsWith("/Cargo.toml")) return parseCargoDependencyNames(source);
  if (file.endsWith("/build.gradle") || file.endsWith("/build.gradle.kts")) return parseGradleDependencyNames(source);
  if (file.endsWith("/go.mod")) return parseGoDependencyNames(source);
  if (file.endsWith("/pom.xml")) return parseMavenDependencyNames(source);
  return new Set();
}

export function inferAddedDependencies(changedFiles, readBaseFile, readHeadFile) {
  const added = { frontend: new Set(), backend: new Set() };

  for (const file of changedFiles) {
    const side = dependencySide(file);
    if (!side) continue;

    const baseNames = parseDependencyNames(file, readBaseFile(file) || "");
    const headNames = parseDependencyNames(file, readHeadFile(file) || "");
    for (const name of headNames) {
      if (!baseNames.has(name)) added[side].add(`${file}:${name}`);
    }
  }

  return added;
}

export function evaluatePullRequestLabels({
  title,
  changedFiles,
  knownDatabaseTypes,
  readBaseFile = () => null,
  readHeadFile = () => null,
}) {
  const files = normalizeChangedFiles(changedFiles);
  const areaLabels = inferAreaLabels(files);
  const labels = new Set(areaLabels.length > 3 ? ["area/multiple"] : areaLabels);
  const typeLabel = inferTypeLabel(title, files);
  if (typeLabel) labels.add(typeLabel);
  if (files.some(isUiChangeFile)) labels.add("ui-change");
  if (files.length > 0 && files.every(isTestFile)) labels.add("tests-only");

  const databaseTypes = inferDatabaseTypes(files, knownDatabaseTypes);
  if (databaseTypes.length > 3) {
    labels.add("db/multiple");
  } else {
    for (const databaseType of databaseTypes) labels.add(`${DATABASE_LABEL_PREFIX}${databaseType}`);
  }

  const addedDependencies = inferAddedDependencies(files, readBaseFile, readHeadFile);
  if (addedDependencies.frontend.size > 0) labels.add("dependencies/frontend");
  if (addedDependencies.backend.size > 0) labels.add("dependencies/backend");

  return {
    addedDependencies: {
      frontend: [...addedDependencies.frontend].sort(),
      backend: [...addedDependencies.backend].sort(),
    },
    databaseTypes,
    files,
    labels: [...labels].sort(),
    typeLabel,
  };
}

function labelNames(labels) {
  return (labels || []).map((label) => (typeof label === "string" ? label : label.name)).filter(Boolean);
}

function loadEvent() {
  if (!process.env.GITHUB_EVENT_PATH || !fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
}

function loadDatabaseCatalog() {
  const manifestUrl = new URL("../../crates/dbx-core/assets/database-drivers.manifest.json", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
  return new Map(manifest.drivers.map((driver) => [driver.dbType, driver.label]));
}

function listChangedFiles(baseSha, headSha) {
  const output = execFileSync("git", ["diff", "--name-only", "-z", `${baseSha}...${headSha}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

function readFileAtRef(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

async function githubRequest(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");

  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || response.statusText;
    const error = new Error(`${method} ${path} failed: ${response.status} ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function ensureLabel(name, spec) {
  try {
    await githubRequest("POST", "/labels", { name, color: spec.color, description: spec.description });
    console.log(`Created label ${name}`);
  } catch (error) {
    if (error.status === 422) return;
    throw error;
  }
}

async function addLabels(pullRequestNumber, names) {
  await githubRequest("POST", `/issues/${pullRequestNumber}/labels`, { labels: names });
}

async function removeLabel(pullRequestNumber, name) {
  try {
    await githubRequest("DELETE", `/issues/${pullRequestNumber}/labels/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
}

function isManagedLabel(name) {
  return TYPE_LABELS.has(name)
    || name.startsWith("area/")
    || name.startsWith(DATABASE_LABEL_PREFIX)
    || name.startsWith("dependencies/")
    || name === "tests-only"
    || name === "ui-change";
}

async function main() {
  const event = loadEvent();
  const pullRequest = event.pull_request;
  if (!pullRequest?.number) throw new Error("Pull request event is required");

  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  if (!baseSha || !headSha) throw new Error("Pull request base and head SHAs are required");

  const databaseCatalog = loadDatabaseCatalog();
  const result = evaluatePullRequestLabels({
    title: pullRequest.title || "",
    changedFiles: listChangedFiles(baseSha, headSha),
    knownDatabaseTypes: new Set(databaseCatalog.keys()),
    readBaseFile: (file) => readFileAtRef(baseSha, file),
    readHeadFile: (file) => readFileAtRef(headSha, file),
  });
  const existingLabels = labelNames(pullRequest.labels);
  const labelsToAdd = result.labels.filter((name) => !existingLabels.includes(name));
  const labelsToRemove = existingLabels.filter((name) => isManagedLabel(name) && !result.labels.includes(name));

  const labelSpecs = { ...STATIC_LABEL_SPECS };
  for (const databaseType of result.databaseTypes) {
    labelSpecs[`${DATABASE_LABEL_PREFIX}${databaseType}`] = {
      color: stablePaletteColor(databaseType),
      description: `Database: ${databaseCatalog.get(databaseType) || databaseType}`,
    };
  }

  console.log(JSON.stringify({
    pullRequest: pullRequest.number,
    title: pullRequest.title,
    ...result,
    existingLabels,
    labelsToAdd,
    labelsToRemove,
  }, null, 2));

  if (dryRun) {
    console.log("Dry run enabled; no GitHub API calls were made");
    return;
  }

  for (const name of labelsToAdd) {
    await ensureLabel(name, labelSpecs[name]);
  }

  if (labelsToAdd.length > 0) {
    await addLabels(pullRequest.number, labelsToAdd);
    console.log(`Added labels: ${labelsToAdd.join(", ")}`);
  }

  for (const name of labelsToRemove) {
    await removeLabel(pullRequest.number, name);
    console.log(`Removed stale label ${name}`);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPoint === import.meta.url) await main();
