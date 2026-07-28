import { describe, expect, it } from "vitest";
import { containsWriteSql, looksLikeActionProposal, looksLikeWriteSqlProposal, shouldGrantWriteSqlOnShortAffirmative, type WriteSqlGrantParams } from "@/lib/ai/aiProposalDetect";
import { aiSkillForAction } from "@/lib/ai/aiSkills";
import { extractFirstSqlCodeBlock, extractSingleSqlCodeBlock, countSqlCodeBlocks } from "@/lib/ai/aiSqlExecutionPolicy";

// ── looksLikeWriteSqlProposal ──────────────────────────────────────────────

describe("looksLikeWriteSqlProposal", () => {
  it("detects zh write-SQL proposal (CREATE in last line)", () => {
    expect(looksLikeWriteSqlProposal("需要我执行 CREATE TABLE users 吗？")).toBe(true);
  });

  it("detects en write-SQL proposal (INSERT in last line)", () => {
    expect(looksLikeWriteSqlProposal("Should I run this INSERT?")).toBe(true);
  });

  it("detects write-SQL proposal split across lines", () => {
    const multi = "已经分析了表结构。\n需要我执行这条 DELETE 语句吗？";
    expect(looksLikeWriteSqlProposal(multi)).toBe(true);
  });

  it("detects generic confirmation phrase when message has SQL code block elsewhere", () => {
    // The prompt instructs the model to ask "需要我执行这条 SQL 吗？"
    // This has no write keywords in the last line, but the message body
    // has CREATE TABLE in a code block — `looksLikeWriteSqlProposal` must
    // check the whole message for write keywords, not just the last line.
    const withCodeBlock = "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT);\n```\n需要我执行这条 SQL 吗？";
    expect(looksLikeWriteSqlProposal(withCodeBlock)).toBe(true);
  });

  it("detects en generic confirmation with SQL code block elsewhere", () => {
    const en = "Here is the SQL:\n```sql\nINSERT INTO users VALUES (1);\n```\nShould I run this?";
    expect(looksLikeWriteSqlProposal(en)).toBe(true);
  });

  it("rejects proposal where write keyword is in an earlier line but last line asks about reading", () => {
    // DELETE appears in first line; the proposal (last line) is about a read query.
    // With the safety rule `lastLineMentionsWriteSql`, this is rejected because
    // the last line does NOT explicitly reference the write SQL or operation.
    const ambiguous = "DELETE 语句会删除所有匹配记录。\n需要我帮你查询一下删除后还剩多少条数据吗？";
    expect(looksLikeActionProposal(ambiguous)).toBe(true);
    expect(containsWriteSql(ambiguous)).toBe(true);
    // REJECTED: last line asks about 查询 (read), not 执行 (write)
    expect(looksLikeWriteSqlProposal(ambiguous)).toBe(false);
  });

  it("rejects read-only proposal even if write keyword appears elsewhere", () => {
    const content = "DROP TABLE is dangerous.\nShould I list the tables for you?";
    expect(containsWriteSql(content)).toBe(true);
    // REJECTED: last line asks about "list" (read), not "execute" (write), and
    // there is no SQL code block connection
    expect(looksLikeWriteSqlProposal(content)).toBe(false);
  });

  it("rejects pure explanation without proposal", () => {
    expect(looksLikeWriteSqlProposal("DELETE 会删除数据，你手动执行吧。")).toBe(false);
  });

  it("rejects empty content", () => {
    expect(looksLikeWriteSqlProposal("")).toBe(false);
  });

  // Safety rule: last line must reference write SQL or write operation

  it("rejects zh proposal where last line asks about read even though message has DELETE", () => {
    // DELETE keyword in first sentence, but last line is about 查询 (read).
    // Without lastLineMentionsWriteSql this was a false-positive.
    const msg = "DELETE 语句会删除所有匹配记录。\n需要我帮你查询一下删除后还剩多少条数据吗？";
    expect(looksLikeWriteSqlProposal(msg)).toBe(false);
  });

  it("rejects en proposal where last line asks about list even though message has DROP", () => {
    const msg = "DROP TABLE is dangerous.\nShould I list the tables for you?";
    expect(looksLikeWriteSqlProposal(msg)).toBe(false);
  });

  it("accepts zh proposal referencing '这条 SQL' when message has write SQL code block", () => {
    const msg = "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT);\n```\n需要我执行这条 SQL 吗？";
    expect(looksLikeWriteSqlProposal(msg)).toBe(true);
  });

  it("accepts en proposal referencing 'this SQL' when message has write SQL code block", () => {
    const msg = "Here is the SQL:\n```sql\nINSERT INTO users VALUES (1);\n```\nShould I run this SQL?";
    expect(looksLikeWriteSqlProposal(msg)).toBe(true);
  });

  it("rejects zh proposal: code block present but last line asks about 查询", () => {
    // Has a write SQL code block, but the last line explicitly asks about a
    // read operation (查询).  This should NOT grant write permission.
    const msg = "```sql\nDELETE FROM old_records;\n```\n需要我帮你查询一下 old_records 还剩多少条吗？";
    expect(looksLikeWriteSqlProposal(msg)).toBe(false);
  });

  it("rejects en proposal: code block present but last line asks about query", () => {
    const msg = "```sql\nDELETE FROM old_records;\n```\nShould I query how many records remain?";
    expect(looksLikeWriteSqlProposal(msg)).toBe(false);
  });
});

// ── shouldGrantWriteSqlOnShortAffirmative ──────────────────────────────────

describe("shouldGrantWriteSqlOnShortAffirmative (manual-typing confirmation)", () => {
  const writeProposal = {
    role: "assistant" as const,
    content: "已经分析了表结构。\n需要我执行这条 CREATE TABLE users 语句吗？",
  };
  const insertProposal = {
    role: "assistant" as const,
    content: "I understand the schema.\nShould I run this INSERT for you?",
  };
  const writeProposalEn = {
    role: "assistant" as const,
    content: "Should I execute this CREATE TABLE users?",
  };
  // Prompt-mirrored generic confirmation with SQL code block.
  const genericZhProposal = {
    role: "assistant" as const,
    content: "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT, name TEXT);\n```\n需要我执行这条 SQL 吗？",
  };

  function params(overrides: Partial<WriteSqlGrantParams> = {}): WriteSqlGrantParams {
    return {
      mode: "agent",
      alreadyGranted: false,
      isProduction: false,
      userText: "可以",
      messages: [{ role: "user", content: "帮我创建表" }, writeProposal],
      ...overrides,
    };
  }

  it("grants when user types 可以 and assistant asked to execute a write", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params())).toBe(true);
  });

  it("grants when user types yes and assistant asked to run INSERT", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ userText: "yes", messages: [{ role: "user", content: "帮我插入" }, insertProposal] }))).toBe(true);
  });

  it("grants when user types go ahead (en)", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ userText: "go ahead", messages: [{ role: "user", content: "please insert" }, writeProposalEn] }))).toBe(true);
  });

  it("grants for generic confirmation phrase when message has SQL code block", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ messages: [{ role: "user", content: "创建表" }, genericZhProposal] }))).toBe(true);
  });

  it("skips contextSummary messages to find the assistant message", () => {
    expect(
      shouldGrantWriteSqlOnShortAffirmative(
        params({
          userText: "好",
          messages: [{ role: "user", content: "帮我创建" }, { role: "assistant", content: "--- context compaction ---", kind: "contextSummary" }, writeProposal],
        }),
      ),
    ).toBe(true);
  });

  it("stops at user messages (does not look past the current turn)", () => {
    expect(
      shouldGrantWriteSqlOnShortAffirmative(
        params({
          messages: [{ role: "user", content: "查一下数据" }, { role: "assistant", content: "SELECT * FROM users 的结果是..." }, { role: "user", content: "现在帮我建表" }, writeProposal],
        }),
      ),
    ).toBe(true);
  });

  // ── negative — write keyword in earlier line, NOT the proposal line ─────

  it("does NOT grant when assistant only explains write SQL without asking to execute", () => {
    const explanation = {
      role: "assistant" as const,
      content: "DELETE 语句会删除所有匹配的数据。当前环境不允许执行写操作，你可以手动在查询器里运行。",
    };
    expect(containsWriteSql(explanation.content)).toBe(true); // has DELETE
    expect(looksLikeActionProposal(explanation.content)).toBe(false); // not a proposal

    expect(shouldGrantWriteSqlOnShortAffirmative(params({ messages: [{ role: "user", content: "帮我删除" }, explanation] }))).toBe(false);
  });

  it("does NOT grant when assistant proposes a non-write action", () => {
    const readProposal = {
      role: "assistant" as const,
      content: "需要我查询一下 users 表的结构吗？",
    };
    expect(looksLikeActionProposal(readProposal.content)).toBe(true);
    expect(looksLikeWriteSqlProposal(readProposal.content)).toBe(false);

    expect(shouldGrantWriteSqlOnShortAffirmative(params({ userText: "好", messages: [{ role: "user", content: "看看有哪些表" }, readProposal] }))).toBe(false);
  });

  // ── guard conditions ────────────────────────────────────────────────────

  it("does NOT grant in ask mode", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ mode: "ask" }))).toBe(false);
  });

  it("does NOT grant when production DB is active", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ isProduction: true }))).toBe(false);
  });

  it("does NOT grant when already granted (avoid overwrite)", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ alreadyGranted: true }))).toBe(false);
  });

  it("does NOT grant when user text is NOT a short affirmative", () => {
    expect(shouldGrantWriteSqlOnShortAffirmative(params({ userText: "好的，我来看看具体情况再说" }))).toBe(false);
  });
});

// ── containsWriteSql regex ──────────────────────────────────────────────────

describe("containsWriteSql regex", () => {
  it("matches INSERT", () => expect(containsWriteSql("INSERT INTO users VALUES (1)")).toBe(true));
  it("matches UPDATE", () => expect(containsWriteSql("UPDATE users SET name='x'")).toBe(true));
  it("matches DELETE", () => expect(containsWriteSql("DELETE FROM users")).toBe(true));
  it("matches CREATE TABLE", () => expect(containsWriteSql("CREATE TABLE t (id INT)")).toBe(true));
  it("matches ALTER TABLE", () => expect(containsWriteSql("ALTER TABLE users ADD COLUMN x INT")).toBe(true));
  it("matches DROP TABLE", () => expect(containsWriteSql("DROP TABLE users")).toBe(true));
  it("matches TRUNCATE", () => expect(containsWriteSql("TRUNCATE TABLE users")).toBe(true));
  it("matches RENAME", () => expect(containsWriteSql("RENAME TABLE old TO new")).toBe(true));
  it("matches GRANT", () => expect(containsWriteSql("GRANT SELECT ON t TO u")).toBe(true));
  it("matches REVOKE", () => expect(containsWriteSql("REVOKE SELECT ON t FROM u")).toBe(true));
  it("matches REPLACE", () => expect(containsWriteSql("REPLACE INTO users VALUES (1)")).toBe(true));
  it("matches MERGE", () => expect(containsWriteSql("MERGE INTO t USING s ON ...")).toBe(true));

  it("case-insensitive: insert", () => expect(containsWriteSql("insert into users")).toBe(true));

  it("does NOT match SELECT", () => expect(containsWriteSql("SELECT * FROM users")).toBe(false));
  it("does NOT match SELECT only content", () => expect(containsWriteSql("需要我帮你查一下数据？")).toBe(false));
  it("does NOT match empty", () => expect(containsWriteSql("")).toBe(false));
});

// ── Button-confirmation flow (looksLikeActionProposal) ──────────────────────

describe("button-confirmation write-SQL flow (looksLikeActionProposal path)", () => {
  it("detects a write-SQL action proposal (需要我执行 CREATE...?)", () => {
    const content = "已经分析了表结构。\n需要我执行 CREATE TABLE users 吗？";
    expect(looksLikeActionProposal(content)).toBe(true);
    expect(looksLikeWriteSqlProposal(content)).toBe(true);
  });

  it("detects a write-SQL action proposal (Should I run this INSERT?)", () => {
    const content = "I think we need to add a row.\nShould I run this INSERT?";
    expect(looksLikeActionProposal(content)).toBe(true);
    expect(looksLikeWriteSqlProposal(content)).toBe(true);
  });

  it("detects generic confirmation phrase when message body has SQL code block", () => {
    const content = "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT, name TEXT);\n```\n需要我执行这条 SQL 吗？";
    expect(looksLikeActionProposal(content)).toBe(true);
    expect(looksLikeWriteSqlProposal(content)).toBe(true);
  });
});

// ── executeAndExplain skill prompt ──────────────────────────────────────────

describe("executeAndExplain write-confirmation prompt", () => {
  it("en: instructs to ask for confirmation instead of blocking", () => {
    const skill = aiSkillForAction("executeAndExplain");
    const enRule = skill.systemRules.en[0];
    expect(enRule).toContain("ask the user for explicit confirmation");
    expect(enRule).toContain("Do not execute writes without user confirmation");
    expect(enRule).not.toContain("do not execute");
  });

  it("zh: instructs to ask for confirmation instead of blocking", () => {
    const skill = aiSkillForAction("executeAndExplain");
    const zhRule = skill.systemRules.zh[0];
    expect(zhRule).toContain("明确询问用户是否确认执行");
    expect(zhRule).toContain("禁止不经确认直接执行写入");
    expect(zhRule).not.toContain("不要执行");
  });
});

// ── extractFirstSqlCodeBlock (SQL binding) ─────────────────────────────────

describe("extractFirstSqlCodeBlock", () => {
  it("extracts SQL from a fenced code block", () => {
    const content = "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT);\n```\n需要我执行这条吗？";
    expect(extractFirstSqlCodeBlock(content)).toBe("CREATE TABLE users (id INT);");
  });

  it("returns undefined when there is no code block", () => {
    const content = "需要我执行 CREATE TABLE users 吗？";
    expect(extractFirstSqlCodeBlock(content)).toBeUndefined();
  });

  it("returns undefined when only an inline code span is present", () => {
    const content = "需要我执行 `CREATE TABLE users` 吗？";
    expect(extractFirstSqlCodeBlock(content)).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(extractFirstSqlCodeBlock("")).toBeUndefined();
  });

  it("extracts SQL from a code block without language tag", () => {
    const content = "Here is the SQL:\n```\nDROP TABLE old;\n```\nShould I execute it?";
    expect(extractFirstSqlCodeBlock(content)).toBe("DROP TABLE old;");
  });
});

// ── countSqlCodeBlocks ──────────────────────────────────────────────────────

describe("countSqlCodeBlocks", () => {
  it("counts zero when there are no code blocks", () => {
    expect(countSqlCodeBlocks("需要我执行 CREATE TABLE users 吗？")).toBe(0);
  });

  it("counts one code block", () => {
    expect(countSqlCodeBlocks("```sql\nSELECT 1;\n```")).toBe(1);
  });

  it("counts two code blocks", () => {
    const content = "```sql\nDELETE FROM old;\n```\n```sql\nDELETE FROM new;\n```";
    expect(countSqlCodeBlocks(content)).toBe(2);
  });

  it("counts three code blocks", () => {
    const content = "```sql\nA\n```\n```\nB\n```\n```sql\nC\n```";
    expect(countSqlCodeBlocks(content)).toBe(3);
  });

  it("counts zero for inline code spans", () => {
    expect(countSqlCodeBlocks("Use `SELECT 1` to test.")).toBe(0);
  });
});

// ── extractSingleSqlCodeBlock (regression: ambiguous multi-block proposals) ──

describe("extractSingleSqlCodeBlock (multi-block safety)", () => {
  it("extracts SQL when exactly one code block exists", () => {
    const content = "以下是建表 SQL：\n```sql\nCREATE TABLE users (id INT);\n```\n需要我执行这条吗？";
    expect(extractSingleSqlCodeBlock(content)).toBe("CREATE TABLE users (id INT);");
  });

  it("returns undefined when there are zero code blocks", () => {
    const content = "需要我执行 CREATE TABLE users 吗？";
    expect(extractSingleSqlCodeBlock(content)).toBeUndefined();
  });

  it("returns undefined when there are multiple code blocks (fail-closed)", () => {
    // Regression: a message with "do not execute" DELETE first, then a
    // recommended DELETE second. extractFirstSqlCodeBlock would return the
    // first (dangerous) block, but extractSingleSqlCodeBlock rightly refuses.
    const content = ["I found two approaches:", "```sql", "DELETE FROM users; -- do NOT execute this", "```", "```sql", "DELETE FROM users WHERE id = 7; -- recommended", "```", "Should I execute the recommended SQL?"].join("\n");
    expect(extractFirstSqlCodeBlock(content)).toBe("DELETE FROM users; -- do NOT execute this");
    expect(extractSingleSqlCodeBlock(content)).toBeUndefined();
  });

  it("returns undefined when multiple blocks have different language tags", () => {
    const content = "```sql\nSELECT 1;\n```\n```postgresql\nSELECT 2;\n```";
    expect(extractSingleSqlCodeBlock(content)).toBeUndefined();
  });

  it("returns undefined when multiple blocks have no language tags", () => {
    const content = "```\nblock A\n```\n```\nblock B\n```";
    expect(extractSingleSqlCodeBlock(content)).toBeUndefined();
  });

  it("counts code blocks case-insensitively for language tags", () => {
    const content = "```SQL\nDELETE FROM a;\n```\n```Sql\nDELETE FROM b;\n```";
    expect(countSqlCodeBlocks(content)).toBe(2);
    expect(extractSingleSqlCodeBlock(content)).toBeUndefined();
  });
});
