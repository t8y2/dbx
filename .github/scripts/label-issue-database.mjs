#!/usr/bin/env node
import fs from "node:fs";

const LABEL_PREFIX = "db/";
const USER_PRIORITY_PREFIX = "user-priority/";
const API_VERSION = "2022-11-28";
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const USER_PRIORITY_LABELS = {
  P0: { color: "b60205", description: "User-reported priority: urgent" },
  P1: { color: "d93f0b", description: "User-reported priority: important" },
  P2: { color: "fbca04", description: "User-reported priority: normal" },
  P3: { color: "bfd4f2", description: "User-reported priority: low" },
};

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

const extraAliases = {
  mysql: ["mariadb", "percona", "tidb"],
  postgres: ["postgresql", "postgres", "pgsql", "pg", "hologres"],
  sqlite: ["sqlite3", "sql lite"],
  clickhouse: ["click house", "ch"],
  sqlserver: ["sql server", "mssql", "microsoft sql server", "sqlservice"],
  mongodb: ["mongo", "mongodb"],
  oracle: ["oracle database"],
  elasticsearch: ["elastic search"],
  chromadb: ["chroma"],
  manticoresearch: ["manticore"],
  dameng: ["dm8", "dameng", "达梦"],
  kingbase: ["kingbasees", "kingbase", "人大金仓", "金仓"],
  highgo: ["瀚高"],
  yashandb: ["yashan", "崖山"],
  saphana: ["hana", "sap hana"],
  opengauss: ["open gauss"],
  "oceanbase-oracle": ["oceanbase", "oceanbase oracle"],
  gbase: ["gbase 8a", "gbase8a", "gbase 8s", "gbase8s"],
  access: ["microsoft access", "ms access"],
  vastbase: ["vastbase g", "vastbaseg"],
  prestosql: ["presto", "presto sql"],
  hive: ["apache hive"],
  db2: ["ibm db2"],
  informix: ["ibm informix"],
  bigquery: ["google bigquery"],
  kylin: ["apache kylin"],
  oscar: ["shentong", "oscar", "神通"],
  xugu: ["xugudb", "xugu", "虚谷"],
  zookeeper: ["zoo keeper", "apache zookeeper"],
  mq: ["message queue", "kafka", "rabbitmq", "rocketmq"],
  iotdb: ["apache iotdb"],
  iris: ["intersystems iris", "intersystems cache", "intersystems caché", "cache", "caché", "ensemble"],
  spark: ["apache spark"],
};

const globallyAmbiguousAliases = new Set([
  "access",
  "ch",
  "h2",
  "iris",
  "jdbc",
  "mq",
  "pg",
  "spark",
]);

const genericDatabaseValues = [
  "general",
  "generic",
  "global",
  "all",
  "any",
  "none",
  "n/a",
  "na",
  "通用",
  "全部",
  "所有",
  "无",
  "不适用",
];

const manifestUrl = new URL("../../crates/dbx-core/assets/database-drivers.manifest.json", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
const drivers = manifest.drivers.map((driver) => ({
  dbType: driver.dbType,
  label: driver.label,
  aliases: [...new Set([driver.dbType, driver.label, ...(extraAliases[driver.dbType] || [])])],
}));
const exactAsciiAliases = new Set(
  drivers.flatMap((driver) => driver.aliases.map((alias) => compactAscii(alias)).filter((alias) => alias.length >= 5)),
);

function loadIssue() {
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    return event.issue || {};
  }

  return {
    number: process.env.ISSUE_NUMBER,
    title: process.env.ISSUE_TITLE || "",
    body: process.env.ISSUE_BODY || "",
    labels: process.env.ISSUE_LABELS ? JSON.parse(process.env.ISSUE_LABELS) : [],
  };
}

function labelNames(labels) {
  return (labels || []).map((label) => (typeof label === "string" ? label : label.name)).filter(Boolean);
}

function stablePaletteColor(value) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  }
  return LABEL_PALETTE[hash % LABEL_PALETTE.length];
}

function extractIssueFormSection(body, predicate) {
  const matches = [...String(body || "").matchAll(/^###\s+(.+?)\s*$/gm)];
  for (const [index, match] of matches.entries()) {
    const heading = match[1].trim();
    if (!predicate(heading)) continue;

    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    return body.slice(start, end).trim();
  }

  return "";
}

function extractDatabaseField(body) {
  return extractIssueFormSection(body, (heading) => (
    heading.includes("数据库类型") ||
    heading.toLowerCase().includes("database type") ||
    /^database$/i.test(heading)
  ));
}

function extractPriorityField(body) {
  return extractIssueFormSection(body, (heading) => (
    heading.includes("优先级") ||
    heading.toLowerCase().includes("priority")
  ));
}

function extractTitleSummaryField(body) {
  const headingPredicates = [
    (heading) => heading.includes("问题描述") || heading.toLowerCase().includes("description"),
    (heading) => heading.includes("当前痛点") || heading.toLowerCase().includes("problem"),
    (heading) => heading.includes("期望方案") || heading.toLowerCase().includes("proposal"),
    (heading) => heading === "描述" || heading.toLowerCase() === "description",
  ];

  for (const predicate of headingPredicates) {
    const section = extractIssueFormSection(body, predicate);
    if (section) return section;
  }

  return "";
}

function matchPriorityLabel(value) {
  const match = String(value || "").normalize("NFKC").match(/\bP([0-3])\b/i);
  return match ? `P${match[1]}` : null;
}

function genericIssueTitlePrefix(title) {
  const normalized = String(title || "").normalize("NFKC").trim().replace(/\s+/g, " ");
  const bracketMatch = normalized.match(/^([\[【][^\]】]*(?:bug|feature|feat|compatibility|question)[^\]】]*[\]】])$/i);
  if (bracketMatch) return bracketMatch[1];

  const bareMatch = normalized.match(/^(bug|feature|feat|compatibility|question):?$/i);
  if (!bareMatch) return null;

  const normalizedPrefix = bareMatch[1].toLowerCase() === "feat" ? "Feat" : (
    bareMatch[1].charAt(0).toUpperCase() + bareMatch[1].slice(1).toLowerCase()
  );
  return `[${normalizedPrefix}]`;
}

function cleanTitleSummaryLine(line) {
  return String(line || "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/!\[[^\]]*?\]\([^)]*?\)/g, "")
    .replace(/\[[^\]]*?\]\([^)]*?\)/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSkippableTitleSummaryLine(line) {
  return (
    /^DBX debug log$/i.test(line) ||
    /^(Exported|User agent|Platform|Timezone):/i.test(line) ||
    /^(Native|Tauri) log dir:/i.test(line) ||
    /^=+.*logs?.*=+$/i.test(line) ||
    /^\[\d{4}-\d{2}-\d{2}(?:T|\])/.test(line) ||
    /^\[(DEBUG|INFO|WARN|ERROR|LOG|STARTUP)\]/i.test(line)
  );
}

function firstSentence(value) {
  const withoutCodeBlocks = String(value || "").replace(/```[\s\S]*?```/g, "\n");
  const lines = withoutCodeBlocks
    .split(/\r?\n/)
    .map(cleanTitleSummaryLine)
    .filter((line) => !isSkippableTitleSummaryLine(line))
    .filter((line) => /[\p{L}\p{N}\u3400-\u9fff]/u.test(line));

  for (const line of lines) {
    const sentenceMatch = line.match(/^(.{4,120}?[。！？!?]|.{12,120}?\.(?=\s|$))/u);
    const sentence = (sentenceMatch ? sentenceMatch[1] : line)
      .replace(/[。！？!?.]+$/u, "")
      .trim();
    if (sentence.length >= 4) {
      return sentence.length > 90 ? `${sentence.slice(0, 89)}…` : sentence;
    }
  }

  return "";
}

function inferIssueTitle(title, body) {
  const prefix = genericIssueTitlePrefix(title);
  if (!prefix) return null;

  const summary = firstSentence(extractTitleSummaryField(body));
  if (!summary) return null;

  return `${prefix} ${summary}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[·，。；：、]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/u.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactAscii(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length];
}

function fuzzyThreshold(length) {
  if (length < 6) return 0;
  if (length <= 8) return 1;
  return 2;
}

function candidateTokens(text) {
  const normalized = normalizeText(text);
  const tokens = new Set();

  for (const match of normalized.matchAll(/[a-z][a-z0-9._-]*/g)) {
    const compact = compactAscii(match[0]);
    if (!compact) continue;

    tokens.add(compact);

    // User reports often write database names directly followed by versions,
    // for example mysql5.7, Oracle19c, or postgresql18.
    const withoutVersion = compact.replace(/(?:v?\d[\da-z.]*)$/i, "");
    if (withoutVersion && withoutVersion !== compact) tokens.add(withoutVersion);
  }

  return [...tokens].filter((token) => token.length >= 5);
}

function fuzzyAliasMatches(text, alias) {
  const normalizedAlias = normalizeText(alias);
  if (containsCjk(normalizedAlias)) return false;
  if (globallyAmbiguousAliases.has(normalizedAlias)) return false;

  const compactAlias = compactAscii(normalizedAlias);
  const threshold = fuzzyThreshold(compactAlias.length);
  if (!threshold) return false;

  return candidateTokens(text).some((token) => {
    if (token !== compactAlias && exactAsciiAliases.has(token)) return false;
    if (Math.abs(token.length - compactAlias.length) > threshold) return false;
    return levenshteinDistance(token, compactAlias) <= threshold;
  });
}

function aliasMatches(text, alias) {
  const normalizedText = normalizeText(text);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;

  if (containsCjk(normalizedAlias)) {
    return normalizedText.includes(normalizedAlias);
  }

  const flexibleAlias = normalizedAlias
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("[\\s._/-]*");
  const trailingBoundary = /[0-9]$/.test(normalizedAlias)
    ? "(?:[^a-z0-9]|$)"
    : "(?:[^a-z0-9]|$|(?=v?\\d))";
  const pattern = new RegExp(`(^|[^a-z0-9])${flexibleAlias}${trailingBoundary}`, "i");
  return pattern.test(normalizedText);
}

function isGenericDatabaseValue(value) {
  const normalized = normalizeText(value);
  const parts = normalized
    .split(/[,\n/|;，、]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    parts.length > 0 &&
    parts.every((part) => genericDatabaseValues.some((generic) => aliasMatches(part, generic)))
  );
}

function matchDrivers(text, { allowAmbiguous }) {
  const matches = [];

  for (const driver of drivers) {
    const matchedAlias = driver.aliases.find((alias) => {
      const normalizedAlias = normalizeText(alias);
      if (!allowAmbiguous && globallyAmbiguousAliases.has(normalizedAlias)) return false;
      return aliasMatches(text, alias) || fuzzyAliasMatches(text, alias);
    });

    if (matchedAlias) {
      matches.push({ ...driver, matchedAlias });
    }
  }

  return matches;
}

function uniqueByDbType(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    if (seen.has(match.dbType)) return false;
    seen.add(match.dbType);
    return true;
  });
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

async function ensureLabel(name, description, color) {
  try {
    const dbType = name.startsWith(LABEL_PREFIX) ? name.slice(LABEL_PREFIX.length) : name;
    await githubRequest("POST", "/labels", { name, color: color || stablePaletteColor(dbType), description });
    console.log(`Created label ${name}`);
  } catch (error) {
    // GitHub returns 422 when the label already exists; that is the common path
    // after the first issue for a database type has been triaged.
    if (error.status === 422) {
      console.log(`Label ${name} already exists`);
      return;
    }
    throw error;
  }
}

async function addLabels(issueNumber, names) {
  await githubRequest("POST", `/issues/${issueNumber}/labels`, { labels: names });
}

async function removeLabel(issueNumber, name) {
  try {
    await githubRequest("DELETE", `/issues/${issueNumber}/labels/${encodeURIComponent(name)}`);
    console.log(`Removed stale label ${name}`);
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
}

async function updateIssueTitle(issueNumber, title) {
  await githubRequest("PATCH", `/issues/${issueNumber}`, { title });
}

const issue = loadIssue();
if (issue.pull_request) {
  console.log("Skipping pull request event");
  process.exit(0);
}

if (!issue.number) {
  throw new Error("Issue number is required");
}

const databaseField = extractDatabaseField(issue.body || "");
const hasDatabaseField = databaseField.length > 0;
const fieldIsGeneric = hasDatabaseField && isGenericDatabaseValue(databaseField);
// Free-form bodies often mention comparison databases or examples; the title
// and issue-form database field are the reliable labeling sources.
const sourceText = hasDatabaseField ? databaseField : issue.title || "";
const matchedDrivers = isGenericDatabaseValue(sourceText)
  ? []
  : uniqueByDbType(matchDrivers(sourceText, { allowAmbiguous: hasDatabaseField }));
const titleMatchedDrivers = uniqueByDbType(matchDrivers(issue.title || "", { allowAmbiguous: false }));
if (hasDatabaseField && titleMatchedDrivers.length > 0) {
  matchedDrivers.push(...titleMatchedDrivers);
}
if (hasDatabaseField && matchedDrivers.length === 0 && !fieldIsGeneric) {
  // Some issue forms contain only a version in the database field and put the
  // actual database name in the title; keep that fallback conservative.
  matchedDrivers.push(
    ...uniqueByDbType(matchDrivers(`${issue.title || ""}\n${databaseField}`, { allowAmbiguous: false })),
  );
}
const uniqueMatchedDrivers = uniqueByDbType(matchedDrivers);
const targetLabels = uniqueMatchedDrivers.map((driver) => `${LABEL_PREFIX}${driver.dbType}`);
const targetLabelColors = Object.fromEntries(
  uniqueMatchedDrivers.map((driver) => [`${LABEL_PREFIX}${driver.dbType}`, stablePaletteColor(driver.dbType)]),
);
const priorityField = extractPriorityField(issue.body || "");
const targetPriorityValue = matchPriorityLabel(priorityField);
const targetPriorityLabel = targetPriorityValue ? `${USER_PRIORITY_PREFIX}${targetPriorityValue}` : null;
if (targetPriorityValue) {
  targetLabelColors[targetPriorityLabel] = USER_PRIORITY_LABELS[targetPriorityValue].color;
}
const existingLabels = labelNames(issue.labels);
const titleToUpdate = inferIssueTitle(issue.title || "", issue.body || "");
const existingDatabaseLabels = existingLabels.filter((name) => name.startsWith(LABEL_PREFIX));
const staleDatabaseLabels = hasDatabaseField
  ? existingDatabaseLabels.filter((name) => !targetLabels.includes(name))
  : [];
const existingPriorityLabels = existingLabels.filter((name) => name.startsWith(USER_PRIORITY_PREFIX));
const stalePriorityLabels = targetPriorityLabel
  ? existingPriorityLabels.filter((name) => name !== targetPriorityLabel)
  : [];
const labelsToAdd = [...targetLabels, targetPriorityLabel].filter(Boolean).filter((name) => !existingLabels.includes(name));
const labelSpecs = [
  ...uniqueMatchedDrivers.map((driver) => ({
    name: `${LABEL_PREFIX}${driver.dbType}`,
    description: `Database: ${driver.label}`,
    color: stablePaletteColor(driver.dbType),
  })),
  ...(targetPriorityValue
    ? [{ name: targetPriorityLabel, ...USER_PRIORITY_LABELS[targetPriorityValue] }]
    : []),
];

console.log(
  JSON.stringify(
    {
      issue: issue.number,
      databaseField: hasDatabaseField ? databaseField : null,
      titleMatched: titleMatchedDrivers.map(({ dbType, label, matchedAlias }) => ({ dbType, label, matchedAlias })),
      matched: uniqueMatchedDrivers.map(({ dbType, label, matchedAlias }) => ({ dbType, label, matchedAlias })),
      priorityField: priorityField || null,
      priorityLabel: targetPriorityLabel,
      priorityValue: targetPriorityValue,
      titleToUpdate,
      labelsToAdd,
      targetLabelColors,
      staleDatabaseLabels,
      stalePriorityLabels,
    },
    null,
    2,
  ),
);

if (dryRun) {
  console.log("Dry run enabled; no GitHub API calls were made");
  process.exit(0);
}

for (const labelSpec of labelSpecs) {
  await ensureLabel(labelSpec.name, labelSpec.description, labelSpec.color);
}

if (labelsToAdd.length > 0) {
  await addLabels(issue.number, labelsToAdd);
  console.log(`Added labels: ${labelsToAdd.join(", ")}`);
} else {
  console.log("No database labels to add");
}

for (const label of staleDatabaseLabels) {
  await removeLabel(issue.number, label);
}

for (const label of stalePriorityLabels) {
  await removeLabel(issue.number, label);
}

if (titleToUpdate) {
  await updateIssueTitle(issue.number, titleToUpdate);
  console.log(`Updated title: ${titleToUpdate}`);
}
