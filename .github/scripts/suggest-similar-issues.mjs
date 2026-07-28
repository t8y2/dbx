#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const COMMENT_MARKER = "<!-- dbx-similar-issues -->";
const MAX_QUERY_LENGTH = 480;
const MAX_CANDIDATES = 3;
const SEARCH_RESULT_LIMIT = 20;

const ignoredSectionPatterns = [
  /^来源$/i,
  /^source$/i,
  /数据库类型/i,
  /database type/i,
  /支持信息/i,
  /support info/i,
  /优先级/i,
  /priority/i,
  /补充信息/i,
  /additional context/i,
  /环境信息/i,
  /environment/i,
];

const genericLatinTokens = new Set([
  "ai",
  "alter",
  "bug",
  "datagrip",
  "dbeaver",
  "dbx",
  "delete",
  "desktop",
  "feature",
  "from",
  "insert",
  "issue",
  "navicat",
  "question",
  "request",
  "select",
  "sql",
  "support",
  "table",
  "update",
  "version",
  "web",
  "where",
  "windows",
]);

const genericCjkTokens = new Set([
  "一个",
  "以及",
  "使用",
  "功能",
  "可以",
  "当前",
  "支持",
  "数据库",
  "新增",
  "增加",
  "希望",
  "异常",
  "操作",
  "所在",
  "数据",
  "显示",
  "没有",
  "现在",
  "设置",
  "问题",
  "进行",
  "错误",
  "需要",
]);
const identifierQueryNoiseTokens = new Set([
  "失效",
  "弹出",
  "快捷",
  "提醒",
  "时候",
  "选择",
]);

const cjkSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const driverManifest = JSON.parse(
  fs.readFileSync(new URL("../../crates/dbx-core/assets/database-drivers.manifest.json", import.meta.url), "utf8"),
);
const extraDatabaseAliases = {
  mysql: ["mariadb", "percona", "tidb"],
  postgres: ["postgresql", "pgsql", "hologres"],
  sqlserver: ["sql server", "mssql"],
  mongodb: ["mongo"],
  dameng: ["dm8", "达梦"],
  kingbase: ["kingbasees", "人大金仓", "金仓"],
  highgo: ["瀚高"],
  yashandb: ["崖山"],
  opengauss: ["open gauss"],
  "oceanbase-oracle": ["oceanbase oracle"],
  gbase: ["gbase8a", "gbase8s"],
};
const databaseDrivers = driverManifest.drivers.map((driver) => ({
  dbType: driver.dbType,
  aliases: [driver.dbType, driver.label, ...(extraDatabaseAliases[driver.dbType] || [])],
}));

function loadIssue() {
  if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).issue || {};
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

function stripIssuePrefix(title) {
  return String(title || "").replace(/^\s*\[[^\]]+\]\s*/u, "").trim();
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/<!--.*?-->/gsu, " ")
    .replace(/<img\b[^>]*>/giu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/^\s*[_*-]{3,}\s*$/gmu, " ");
}

function parseIssueSections(body) {
  const text = String(body || "");
  const headings = [...text.matchAll(/^###\s+(.+?)\s*$/gmu)];
  if (headings.length === 0) return [{ heading: "", content: text }];

  return headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    return { heading: heading[1].trim(), content: text.slice(start, end).trim() };
  });
}

function databaseField(body) {
  const section = parseIssueSections(body).find(({ heading }) => /数据库类型|database type/iu.test(heading))?.content;
  if (section) return section;

  // Bot-created issues historically used a bold inline metadata field instead of an issue-form heading.
  const inline = String(body || "").match(/^\s*\*\*(?:数据库类型(?:和版本)?|database type)\*\*\s*[:：]\s*(.+?)\s*$/imu);
  return inline?.[1]?.trim() || "";
}

function relevantBody(body) {
  const sections = parseIssueSections(body).filter(
    ({ heading }) => !ignoredSectionPatterns.some((pattern) => pattern.test(heading)),
  );
  return stripMarkdown(sections.map(({ content }) => content).join("\n")).slice(0, 2400);
}

function normalizeText(value) {
  return stripMarkdown(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}+._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function searchTerms(issue) {
  const title = normalizeText(stripIssuePrefix(issue.title));
  const body = normalizeText(relevantBody(issue.body));
  const terms = `${title} ${body}`
    .split(/\s+/u)
    .filter((term) => term.length >= 2)
    .slice(0, 80)
    .join(" ");
  return terms.slice(0, MAX_QUERY_LENGTH).trim();
}

function semanticTokens(value) {
  const normalized = normalizeText(value).replace(/[+._-]+/gu, " ");
  const result = new Set(latinTokens(normalized));
  let singleHanRun = "";
  const flushSingleHanRun = () => {
    for (let index = 0; index + 1 < singleHanRun.length; index += 2) {
      const token = singleHanRun.slice(index, index + 2);
      if (!genericCjkTokens.has(token)) result.add(token);
    }
    singleHanRun = "";
  };

  for (const part of cjkSegmenter.segment(normalized)) {
    const token = part.segment.trim();
    if (part.isWordLike && /^\p{Script=Han}$/u.test(token)) {
      singleHanRun += token;
      continue;
    }
    flushSingleHanRun();
    if (!part.isWordLike || token.length < 2 || genericCjkTokens.has(token)) continue;
    result.add(token);
  }
  flushSingleHanRun();
  return result;
}

export function searchTitleTerms(issue) {
  const identifiers = technicalIdentifiers(issue);
  const tokens = [...semanticTokens(stripIssuePrefix(issue.title))].filter(
    (token) => identifiers.size === 0 || !identifierQueryNoiseTokens.has(token),
  );
  return tokens.slice(0, 8).join(" ").slice(0, MAX_QUERY_LENGTH);
}

function latinTokens(value) {
  return new Set(
    normalizeText(value)
      .match(/[a-z0-9][a-z0-9+._-]{1,}/gu)
      ?.filter((token) => (
        !genericLatinTokens.has(token)
        && !/^v?\d+(?:[._-]\d+)*$/u.test(token)
        && !/^(.)\1{2,}$/u.test(token)
      )) || [],
  );
}

function characterNgrams(value, size = 3) {
  const compact = normalizeText(value).replace(/\s+/gu, "");
  const result = new Set();
  for (let index = 0; index <= compact.length - size; index += 1) {
    result.add(compact.slice(index, index + size));
  }
  return result;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function diceCoefficient(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  return (2 * intersectionSize(left, right)) / (left.size + right.size);
}

function typeLabels(labels) {
  const types = new Set(["bug", "enhancement", "question"]);
  return new Set(labelNames(labels).filter((label) => types.has(label)));
}

function databaseLabels(labels) {
  return new Set(labelNames(labels).filter((label) => label.startsWith("db/")));
}

function databaseTypes(issue) {
  const result = new Set([...databaseLabels(issue.labels)].map((label) => label.slice(3)));
  const compactField = normalizeText(databaseField(issue.body)).replace(/[^\p{Letter}\p{Number}]+/gu, "");
  if (!compactField) return result;

  for (const driver of databaseDrivers) {
    const matched = driver.aliases.some((alias) => {
      const compactAlias = normalizeText(alias).replace(/[^\p{Letter}\p{Number}]+/gu, "");
      return compactAlias.length >= 3 && compactField.includes(compactAlias);
    });
    if (matched) result.add(driver.dbType);
  }
  return result;
}

function databaseContentTokens(issue) {
  const result = new Set();
  const types = databaseTypes(issue);
  for (const driver of databaseDrivers) {
    if (!types.has(driver.dbType)) continue;
    for (const alias of driver.aliases) {
      for (const token of semanticTokens(alias)) result.add(token);
    }
  }
  return result;
}

function contentTitleTokens(issue) {
  const tokens = semanticTokens(stripIssuePrefix(issue.title));
  const databaseTokens = databaseContentTokens(issue);
  return new Set([...tokens].filter((token) => !databaseTokens.has(token)));
}

function contentTitleText(issue) {
  return [...contentTitleTokens(issue)].join(" ");
}

function setsOverlap(left, right) {
  return intersectionSize(left, right) > 0;
}

function highSignalBody(body) {
  const sections = parseIssueSections(body);
  const selected = sections.filter(({ heading }) => /错误|异常|日志|error|exception|log/iu.test(heading));
  return stripMarkdown(selected.map(({ content }) => content).join("\n")).slice(0, 1200);
}

function technicalIdentifiers(issue) {
  const identifiers = latinTokens(`${stripIssuePrefix(issue.title)}\n${highSignalBody(issue.body)}`);
  const databaseTokens = databaseContentTokens(issue);
  return new Set([...identifiers].filter((token) => !databaseTokens.has(token)));
}

function inverseDocumentFrequency(documentCount, documentFrequency) {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function tokenOccurrenceCount(value, token) {
  const normalized = normalizeText(value).replace(/[+._-]+/gu, " ");
  let count = 0;
  let offset = 0;
  while ((offset = normalized.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function weightedCoverage(queryTokens, candidateTokens, weights) {
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const weight = weights.get(token) || 0;
    if (weight === 0) continue;
    totalWeight += weight;
    if (candidateTokens.has(token)) matchedWeight += weight;
  }
  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

export function buildCorpusContext(issue, candidates) {
  const issueTitle = stripIssuePrefix(issue.title);
  const queryTitleTokens = contentTitleTokens(issue);
  const candidateTitleTokens = candidates.map((candidate) => contentTitleTokens(candidate));
  const weights = new Map();
  const frequencies = new Map();

  for (const token of queryTitleTokens) {
    const documentFrequency = candidateTitleTokens.reduce(
      (count, tokens) => count + (tokens.has(token) ? 1 : 0),
      0,
    );
    frequencies.set(token, documentFrequency);
    const queryFrequencyBoost = 1 + Math.log(Math.max(1, tokenOccurrenceCount(issueTitle, token)));
    weights.set(token, inverseDocumentFrequency(candidates.length, documentFrequency) * queryFrequencyBoost);
  }

  const observedWeights = [...queryTitleTokens]
    .filter((token) => (frequencies.get(token) || 0) > 0)
    .map((token) => weights.get(token) || 0);
  const maximumWeight = Math.max(0, ...observedWeights);
  const anchorTokens = new Set(
    [...queryTitleTokens].filter((token) => (
      maximumWeight > 0
      && (frequencies.get(token) || 0) > 0
      && (weights.get(token) || 0) >= maximumWeight * 0.9
    )),
  );

  return { queryTitleTokens, candidateTitleTokens, weights, anchorTokens };
}

export function scoreCandidate(issue, candidate, rank = 0, corpusContext) {
  const issueDatabases = databaseTypes(issue);
  const candidateDatabases = databaseTypes(candidate);
  if (issueDatabases.size > 0 && candidateDatabases.size > 0 && !setsOverlap(issueDatabases, candidateDatabases)) {
    return { accepted: false, score: 0, reason: "database-mismatch" };
  }

  const issueTitle = stripIssuePrefix(issue.title);
  const candidateTitle = stripIssuePrefix(candidate.title);
  const issueBody = relevantBody(issue.body).slice(0, 1200);
  const candidateBody = relevantBody(candidate.body).slice(0, 1200);
  const titleSimilarity = diceCoefficient(
    characterNgrams(contentTitleText(issue)),
    characterNgrams(contentTitleText(candidate)),
  );
  const bodySimilarity = diceCoefficient(characterNgrams(issueBody), characterNgrams(candidateBody));
  const context = corpusContext || buildCorpusContext(issue, [candidate]);
  const candidateTitleTokens = corpusContext
    ? context.candidateTitleTokens[rank]
    : context.candidateTitleTokens[0];
  const titleCoverage = weightedCoverage(context.queryTitleTokens, candidateTitleTokens, context.weights);
  const anchorHit = setsOverlap(candidateTitleTokens, context.anchorTokens);
  const issueIdentifiers = technicalIdentifiers(issue);
  const candidateIdentifiers = technicalIdentifiers(candidate);
  const identifierCoverage = issueIdentifiers.size === 0
    ? 0
    : intersectionSize(issueIdentifiers, candidateIdentifiers) / issueIdentifiers.size;
  const rankPrior = 1 / Math.log2(rank + 2);

  let score = titleCoverage * 0.45
    + titleSimilarity * 0.25
    + bodySimilarity * 0.1
    + identifierCoverage * 0.15
    + rankPrior * 0.05;
  const issueTypes = typeLabels(issue.labels);
  const candidateTypes = typeLabels(candidate.labels);
  if (issueTypes.size > 0 && candidateTypes.size > 0) {
    score += setsOverlap(issueTypes, candidateTypes) ? 0.02 : -0.06;
  }
  if (issueDatabases.size > 0 && candidateDatabases.size > 0) score += 0.04;

  // Like Discourse, retrieval is deliberately broad and public suggestions
  // require a separate threshold. Rare title terms act as BM25F-style anchors.
  const accepted = score >= 0.34
    || (anchorHit && titleCoverage >= 0.38 && score >= 0.2)
    || (identifierCoverage >= 0.5 && titleCoverage >= 0.2 && score >= 0.28)
    || (titleSimilarity + bodySimilarity >= 0.42 && score >= 0.28);

  return {
    accepted,
    score,
    signals: {
      titleSimilarity,
      titleCoverage,
      bodySimilarity,
      identifierCoverage,
      anchorHit,
      rankPrior,
    },
  };
}

export function rankCandidates(issue, items) {
  const candidates = items.filter(
    (candidate) => !candidate.pull_request && Number(candidate.number) !== Number(issue.number),
  );
  const context = buildCorpusContext(issue, candidates);
  return candidates
    .map((candidate, rank) => ({ candidate, ...scoreCandidate(issue, candidate, rank, context) }))
    .filter((result) => result.accepted)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CANDIDATES);
}

function hasChinese(value) {
  return /\p{Script=Han}/u.test(String(value || ""));
}

export function formatComment(issue, rankedCandidates) {
  const chinese = hasChinese(`${issue.title}\n${issue.body}`);
  // GitHub expands issue references into links containing the title and number.
  const lines = rankedCandidates.map(({ candidate }) => `- #${candidate.number}`);

  if (chinese) {
    return `${COMMENT_MARKER}\n以下 Issue 可能与当前问题相关：\n\n${lines.join("\n")}\n\n这些结果由机器人自动检索，尚未确认重复。如属于同一问题，建议在已有 Issue 中补充信息。`;
  }

  return `${COMMENT_MARKER}\nThe following issues may be related:\n\n${lines.join("\n")}\n\nThese results were found automatically and are not confirmed duplicates. If this is the same problem, consider adding details to the existing issue.`;
}

export class GitHubClient {
  constructor({ token, repository, apiBase = "https://api.github.com" }) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    if (!repository) throw new Error("GITHUB_REPOSITORY is required");
    this.token = token;
    this.repository = repository;
    this.apiBase = apiBase.replace(/\/$/u, "");
  }

  async request(method, path, body) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`${method} ${path} failed: ${response.status} ${payload?.message || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async searchIssues(query) {
    const parameters = new URLSearchParams({
      q: `repo:${this.repository} is:issue ${query}`,
      search_type: "hybrid",
      per_page: String(SEARCH_RESULT_LIMIT),
    });
    return this.request("GET", `/search/issues?${parameters}`);
  }

  async hasExistingComment(issueNumber) {
    const comments = await this.request("GET", `/repos/${this.repository}/issues/${issueNumber}/comments?per_page=100`);
    return comments.some((comment) => String(comment.body || "").includes(COMMENT_MARKER));
  }

  async comment(issueNumber, body) {
    return this.request("POST", `/repos/${this.repository}/issues/${issueNumber}/comments`, { body });
  }
}

export async function run({ issue = loadIssue(), client } = {}) {
  if (issue.pull_request) {
    console.log("Skipping pull request event");
    return [];
  }
  if (!issue.number) throw new Error("Issue number is required");

  const query = searchTitleTerms(issue) || searchTerms(issue);
  if (query.length < 2) {
    console.log("Skipping similar issue search because the issue has too little searchable text");
    return [];
  }

  const github = client || new GitHubClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiBase: process.env.GITHUB_API_URL,
  });
  if (await github.hasExistingComment(issue.number)) {
    console.log("Similar issue comment already exists");
    return [];
  }

  let result;
  try {
    result = await github.searchIssues(query);
  } catch (error) {
    // Similar-issue suggestions are best-effort and must not turn a temporary
    // semantic-search rate limit into a failed issue workflow.
    if (error.status === 403 && /rate limit/iu.test(error.message)) {
      console.warn(`Skipping similar issue search: ${error.message}`);
      return [];
    }
    throw error;
  }
  const candidates = rankCandidates(issue, result.items || []);
  if (candidates.length === 0) {
    console.log(`No sufficiently similar issues found (${result.search_type || "unknown"} search)`);
    return [];
  }

  if (process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true") {
    console.log(formatComment(issue, candidates));
    return candidates;
  }

  await github.comment(issue.number, formatComment(issue, candidates));
  console.log(`Commented ${candidates.length} similar issue suggestion(s) on #${issue.number}`);
  return candidates;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run();
}
