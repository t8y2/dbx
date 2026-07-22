import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  GitHubClient,
  formatComment,
  rankCandidates,
  run,
  scoreCandidate,
  searchTerms,
  searchTitleTerms,
} from "./suggest-similar-issues.mjs";

const baseIssue = {
  number: 4043,
  title: "[Bug] 设置快捷键(Ctrl+Enter)执行光标所在语句失效了",
  body: `### 数据库类型和版本

MySQL 8.0

### 问题描述

设置快捷键 Ctrl+Enter 执行光标所在语句，现在会弹出选择框。

### 支持信息

DBX 版本: v0.5.62`,
  labels: [{ name: "bug" }, { name: "db/mysql" }],
};

test("accepts a candidate with matching shortcut and execution behavior", () => {
  const candidate = {
    number: 82,
    title: "[Feature] 设置里 ctrl+enter 执行功能添加模式选择",
    body: "希望 Ctrl+Enter 可以直接执行光标所在 SQL 语句，不要弹出选择框。",
    labels: [{ name: "enhancement" }, { name: "db/mysql" }],
  };

  const result = scoreCandidate(baseIssue, candidate);
  assert.equal(result.accepted, true);
  assert.equal(result.signals.identifierCoverage, 1);
});

test("builds a short title query with identifiers split safely", () => {
  const query = searchTitleTerms(baseIssue);
  assert.match(query, /\bctrl\b/u);
  assert.match(query, /\benter\b/u);
  assert.doesNotMatch(query, /ctrl\+enter/u);
  assert.match(query, /执行/u);
  assert.match(query, /光标/u);
  assert.match(query, /语句/u);
  assert.doesNotMatch(query, /失效|弹出/u);
});

test("excludes bot source metadata from searchable text", () => {
  const issue = {
    ...baseIssue,
    body: `### 来源

QQ 群反馈 · **反馈人**：独特反馈人名称

### 原始描述

查询结果无法保存。`,
  };

  const terms = searchTerms(issue);
  assert.doesNotMatch(terms, /QQ群反馈|独特反馈人名称/u);
  assert.match(terms, /查询结果无法保存/u);
});

test("keeps compound Chinese product terms in the title query", () => {
  const query = searchTitleTerms({ title: "[Feature] 增加多列选中转置功能、增加转置列注释" });
  assert.match(query, /多列/u);
  assert.match(query, /转置/u);
  assert.match(query, /注释/u);
});

test("rejects a candidate with conflicting database labels", () => {
  const candidate = {
    number: 100,
    title: "Ctrl+Enter 执行语句异常",
    body: "快捷键无法执行当前语句。",
    labels: [{ name: "bug" }, { name: "db/postgres" }],
  };

  assert.deepEqual(scoreCandidate(baseIssue, candidate), {
    accepted: false,
    score: 0,
    reason: "database-mismatch",
  });
});

test("detects database conflicts from issue forms before labels are added", () => {
  const issue = {
    number: 300,
    title: "[Bug] 查询保存失败",
    body: "### 数据库类型和版本\n\nPostgreSQL 16\n\n### 问题描述\n\n修改后保存失败。",
    labels: [{ name: "bug" }],
  };
  const mysqlCandidate = {
    number: 301,
    title: "[Bug] 查询保存失败",
    body: "### 数据库类型和版本\n\nMySQL 8.0\n\n### 问题描述\n\n修改后保存失败。",
    labels: [{ name: "bug" }],
  };
  const postgresCandidate = {
    number: 302,
    title: "[Bug] 查询保存失败",
    body: "### Database type and version\n\nPostgres 15\n\n### Description\n\nSaving changes fails.",
    labels: [{ name: "bug" }],
  };

  assert.equal(scoreCandidate(issue, mysqlCandidate).reason, "database-mismatch");
  assert.equal(scoreCandidate(issue, postgresCandidate).accepted, true);
});

test("detects database conflicts from legacy bot metadata", () => {
  const issue = {
    ...baseIssue,
    body: "**来源**: QQ 群反馈\n**数据库类型和版本**: PostgreSQL 16\n\n## 原始描述\n修改后保存失败。",
    labels: [{ name: "bug" }],
  };
  const candidate = {
    number: 102,
    title: "MySQL 查询结果修改后保存失败",
    body: "### 数据库类型和版本\n\nMySQL 8.0\n\n### 问题描述\n\n修改后保存失败。",
    labels: [{ name: "bug" }],
  };

  assert.equal(scoreCandidate(issue, candidate).reason, "database-mismatch");
});

test("does not treat a shared database product as issue similarity", () => {
  const issue = {
    number: 4048,
    title: "[Bug] OceanBase数据库Oracle模式下显示错误且无法修改数据",
    body: "### 数据库类型和版本\n\nOceanBase Oracle\n\n### 问题描述\n\n查询后无法修改表数据。",
    labels: [{ name: "bug" }],
  };
  const candidates = [
    {
      number: 2549,
      title: "[Feature] OceanBase数据库的Oracle模式显示更多内容",
      body: "### 数据库类型和版本\n\nOceanBase Oracle",
      labels: [{ name: "enhancement" }, { name: "db/oceanbase-oracle" }],
    },
    {
      number: 2489,
      title: "OceanBase Oracle模式下NUMBER类型查询精度丢失",
      body: "### 数据库类型和版本\n\nOceanBase Oracle",
      labels: [{ name: "bug" }, { name: "db/oceanbase-oracle" }],
    },
  ];

  assert.deepEqual(rankCandidates(issue, candidates), []);
});

test("rejects broad semantic matches without concrete shared terms", () => {
  const candidate = {
    number: 200,
    title: "[Bug] SQL 编辑器光标显示不出来",
    body: "打开编辑器后看不到光标，但查询仍可执行。",
    labels: [{ name: "bug" }, { name: "db/mysql" }],
  };

  assert.equal(scoreCandidate(baseIssue, candidate).accepted, false);
});

test("prefers matching title concepts over a shared product reference", () => {
  const issue = {
    number: 4057,
    title: "[Feature] 增加多列选中转置功能、增加转置列注释",
    body: "希望参考 DBeaver，同时预览多行转置数据并显示列注释。",
    labels: [{ name: "enhancement" }],
  };
  const related = {
    number: 2201,
    title: "转置视图：同时显示字段注释和类型",
    body: "转置结果中显示字段注释。",
    labels: [{ name: "enhancement" }],
  };
  const unrelated = {
    number: 4055,
    title: "[Feature] 增加字段拖动到编辑器、输入框中",
    body: "参考 DBeaver，将字段拖进 SQL 编辑器。",
    labels: [{ name: "enhancement" }],
  };

  assert.ok(scoreCandidate(issue, related).score > scoreCandidate(issue, unrelated).score);
});

test("uses corpus rarity to reject generic real-world matches", () => {
  const issue = {
    number: 4057,
    title: "[Feature] 增加多列选中转置功能、增加转置列注释",
    body: "希望多行同时转置进行对比，并显示列注释。",
    labels: [{ name: "enhancement" }],
  };
  const candidates = [
    { number: 3556, title: "优化左侧连接信息表中文注释的显示和拖动行为", labels: [{ name: "enhancement" }] },
    { number: 3496, title: "查询结果支持多选行批量修改字段值", labels: [{ name: "enhancement" }] },
    { number: 2160, title: "光标批量选中卡顿且建议增加批量注释功能", labels: [{ name: "enhancement" }] },
    { number: 1652, title: "建议增加一键多行注释和一键取消多行注释功能", labels: [{ name: "enhancement" }] },
    {
      number: 2201,
      title: "转置视图：同时显示字段注释和类型",
      body: "转置结果中显示字段注释。",
      labels: [{ name: "enhancement" }],
    },
    { number: 2129, title: "支持悬停显示字段注释并修复结果字段注释", labels: [{ name: "enhancement" }] },
  ];

  const ranked = rankCandidates(issue, candidates);
  assert.deepEqual(ranked.map(({ candidate }) => candidate.number), [2201]);
  assert.equal(ranked[0].signals.anchorHit, true);
});

test("ranks candidates, excludes the current issue and limits output", () => {
  const candidates = [
    { ...baseIssue },
    {
      number: 82,
      title: "Ctrl+Enter 执行当前 SQL 语句",
      body: "Ctrl+Enter 直接执行光标所在语句，不显示选择框。",
      state: "open",
      labels: [{ name: "bug" }, { name: "db/mysql" }],
    },
    {
      number: 83,
      title: "Ctrl+Enter 快捷键执行 SQL",
      body: "执行光标当前语句时快捷键弹出选择框。",
      state: "closed",
      labels: [{ name: "bug" }, { name: "db/mysql" }],
    },
    {
      number: 84,
      title: "SQL 编辑器光标颜色",
      body: "光标在暗色主题下不明显。",
      labels: [{ name: "bug" }],
    },
  ];

  const ranked = rankCandidates(baseIssue, candidates);
  assert.deepEqual(new Set(ranked.map(({ candidate }) => candidate.number)), new Set([82, 83]));
});

test("formats a cautious localized comment with concise issue references", () => {
  const comment = formatComment(baseIssue, [
    { candidate: { number: 82, title: "[Bug] [快捷键](https://example.com)", state: "closed" } },
  ]);

  assert.match(comment, /^<!-- dbx-similar-issues -->/u);
  assert.match(comment, /\n- #82\n/u);
  assert.match(comment, /尚未确认重复/u);
  assert.doesNotMatch(comment, /快捷键|已关闭|https:/u);
});

test("run searches and posts one idempotent comment", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader("Content-Type", "application/json");

      if (request.method === "GET" && request.url.includes("/comments")) {
        response.end("[]");
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/search/issues?")) {
        response.end(JSON.stringify({
          search_type: "hybrid",
          items: [{
            number: 82,
            title: "Ctrl+Enter 执行当前 SQL 语句",
            body: "Ctrl+Enter 直接执行光标所在语句，不显示选择框。",
            state: "open",
            labels: [{ name: "bug" }, { name: "db/mysql" }],
          }],
        }));
        return;
      }
      if (request.method === "POST" && request.url.endsWith("/comments")) {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: 1 }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const client = new GitHubClient({
    token: "test-token",
    repository: "t8y2/dbx",
    apiBase: `http://127.0.0.1:${address.port}`,
  });
  const candidates = await run({ issue: baseIssue, client });

  assert.equal(candidates.length, 1);
  assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
  const searchRequests = requests.filter(({ url }) => url.startsWith("/search/issues?"));
  assert.equal(searchRequests.length, 1);
  for (const searchRequest of searchRequests) {
    const parameters = new URL(searchRequest.url, "http://localhost").searchParams;
    assert.equal(parameters.get("search_type"), "hybrid");
    assert.equal(parameters.get("per_page"), "20");
    assert.match(parameters.get("q"), /^repo:t8y2\/dbx is:issue /u);
    assert.ok(parameters.get("q").length < 600);
  }
});

test("run treats hybrid search rate limits as best-effort", async () => {
  const error = new Error("rate limit exceeded");
  error.status = 403;
  const client = {
    hasExistingComment: async () => false,
    searchIssues: async () => {
      throw error;
    },
  };

  assert.deepEqual(await run({ issue: baseIssue, client }), []);
});

test("run does not hide non-rate-limit permission failures", async () => {
  const error = new Error("Resource not accessible by integration");
  error.status = 403;
  const client = {
    hasExistingComment: async () => false,
    searchIssues: async () => {
      throw error;
    },
  };

  await assert.rejects(() => run({ issue: baseIssue, client }), /Resource not accessible/u);
});

test("run skips search when its marker already exists", async () => {
  let searched = false;
  const client = {
    hasExistingComment: async () => true,
    searchIssues: async () => {
      searched = true;
      return { items: [] };
    },
  };

  assert.deepEqual(await run({ issue: baseIssue, client }), []);
  assert.equal(searched, false);
});
