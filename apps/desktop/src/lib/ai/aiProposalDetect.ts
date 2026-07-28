/**
 * Pure detectors for recognizing AI assistant action proposals and user
 * short replies (affirmative / negative). Used by the chat UI to render
 * a quick action confirmation bar instead of requiring the user to type.
 *
 * Detectors are intentionally narrow:
 * - A "proposal" requires both a first-person/asking phrase AND an
 *   actionable intent verb (execute query, fetch data, investigate, etc.)
 * - Affirmative / negative detectors only match short replies (the user
 *   typing a couple of words). Long replies fall through.
 *
 * Side-effect free. Safe to import from anywhere.
 */

/** Trim whitespace, leading/trailing punctuation (CJK + ASCII) for short-reply matching. */
function stripOuterPunctuation(input: string): string {
  return input
    .replace(/^[\s　]+/, "")
    .replace(/[\s　]+$/, "")
    .replace(/^[!?.,;:！？。，；：]+/, "")
    .replace(/[!?.,;:！？。，；：]+$/, "");
}

/** Returns the last non-empty line/sentence-ish chunk of the assistant message. */
export function lastNonEmptyLine(content: string): string {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** True when the string contains at least one CJK ideograph. */
export function containsChinese(input: string): boolean {
  return /[一-鿿]/.test(input);
}

// Phrases that indicate the assistant is asking permission to take an action.
const ZH_ASK_PHRASES = [
  /需要我/, // "do you need me to"
  /要不要我/, // "shall I"
  /是否需要/, // "is it needed"
  /帮我?(?:你)?/, // "shall I help" (loose)
  /我来/, // "let me"
  /我帮你/, // "let me help you"
  /我现在/, // "shall I now"
  /我可以/, // "may I"
  /我去/, // "shall I go"
  /我能/, // "may I"
];

const EN_ASK_PHRASES = [/\bshould\s+i\b/i, /\bdo\s+you\s+want\s+me\s+to\b/i, /\bwould\s+you\s+like\s+me\s+to\b/i, /\bwant\s+me\s+to\b/i, /\bshall\s+i\b/i, /\bcan\s+i\b/i, /\blet\s+me\s+know\s+if\s+you\s+want\s+me\s+to\b/i];

// Actionable intent verbs/phrases. Must co-occur with an ask phrase to count.
const ZH_ACTION_PHRASES = [
  /执行/, // execute
  /运行/, // run
  /查询/, // query
  /查看/, // view
  /看看/,
  /查一下/, // check
  /拉取/, // fetch
  /获取/, // get/fetch
  /读取/, // read
  /取出?/, // take out / extract
  /取数据/,
  /看看数据/,
  /看一下/,
  /分析/, // analyze
  /统计/, // count/aggregate
  /排查/, // investigate
  /调查/, // investigate
  /生成/, // generate
  /创建/, // create
  /列出/, // list
  /对比/, // compare
];

const EN_ACTION_PHRASES = [
  /\bexecute\b/i,
  /\brun\b/i,
  /\bquery\b/i,
  /\bfetch\b/i,
  /\bpull\b/i,
  /\bretrieve\b/i,
  /\bread\b/i,
  /\bget\s+(?:the\s+)?(?:data|rows|sample|columns|results)\b/i,
  /\banalyze\b/i,
  /\binvestigate\b/i,
  /\bcheck\b/i,
  /\binspect\b/i,
  /\bgenerate\b/i,
  /\bcreate\b/i,
  /\blist\b/i,
  /\bcompare\b/i,
  /\bcount\b/i,
  /\bsample\b/i,
];

/**
 * Detect whether the assistant message ends with a proposal-style question
 * such as "Should I execute this query?" / "需要我拉取这两个表的数据吗？".
 *
 * Heuristic:
 * - Looks at the last non-empty line.
 * - Must end with a question mark (Chinese ？ or English ?).
 * - Must contain BOTH a first-person ask phrase AND an actionable intent.
 *
 * Returns false for generic clarifying questions (no actionable verb).
 */
export function looksLikeActionProposal(content: string): boolean {
  if (!content) return false;
  const lastLine = lastNonEmptyLine(content);
  if (!lastLine) return false;

  // Must be a question.
  if (!/[?？]\s*$/.test(lastLine)) return false;

  const isZh = containsChinese(lastLine);
  const askPhrases = isZh ? ZH_ASK_PHRASES : EN_ASK_PHRASES;
  const actionPhrases = isZh ? ZH_ACTION_PHRASES : EN_ACTION_PHRASES;

  const hasAsk = askPhrases.some((re) => re.test(lastLine));
  if (!hasAsk) return false;

  const hasAction = actionPhrases.some((re) => re.test(lastLine));
  return hasAction;
}

// Short affirmative words/phrases. Must match (after stripping punctuation /
// whitespace) the entire reply for it to count — long replies fall through.
const ZH_AFFIRMATIVE = [/^需要$/, /^需要的$/, /^要$/, /^要的$/, /^好$/, /^好的$/, /^可以$/, /^行$/, /^是$/, /^是的$/, /^对$/, /^对的$/, /^嗯$/, /^嗯嗯$/, /^OK$/i, /^OKK*$/i, /^没问题$/, /^请$/, /^麻烦了$/, /^来吧$/, /^继续$/];

const EN_AFFIRMATIVE = [/^yes$/i, /^yeah$/i, /^yep$/i, /^y$/i, /^ok$/i, /^okay$/i, /^k$/i, /^sure$/i, /^go$/i, /^go\s+ahead$/i, /^do\s+it$/i, /^please\s+do$/i, /^please$/i, /^proceed$/i, /^continue$/i, /^confirm(?:ed)?$/i];

const ZH_NEGATIVE = [/^不$/, /^不用$/, /^不用了$/, /^不需要$/, /^不要$/, /^别$/, /^先不$/, /^先不(?:用|要)$/, /^算了$/, /^不必$/, /^取消$/, /^停$/, /^先别$/];

const EN_NEGATIVE = [/^no$/i, /^nope$/i, /^nah$/i, /^n$/i, /^don'?t$/i, /^do\s+not$/i, /^not\s+needed$/i, /^skip$/i, /^cancel$/i, /^stop$/i, /^never\s*mind$/i, /^nvm$/i, /^hold\s+off$/i, /^not\s+now$/i];

/**
 * Detect "short affirmative" user replies like 需要 / 好 / 可以 / 是 / 对 /
 * 嗯 / yes / ok / sure / go ahead / do it.
 *
 * Long messages (multiple sentences, or words mixed with extra context)
 * intentionally do NOT match — those should be sent to the LLM normally.
 */
export function isShortAffirmative(content: string): boolean {
  const cleaned = stripOuterPunctuation(content);
  if (!cleaned) return false;
  // Reject when the reply has multiple words/lines unless still very short
  // and matches a known phrase (e.g. "go ahead" / "do it" / "好的").
  if (cleaned.length > 24) return false;
  const all = [...ZH_AFFIRMATIVE, ...EN_AFFIRMATIVE];
  return all.some((re) => re.test(cleaned));
}

/**
 * Detect "short negative" user replies like 不用 / 不需要 / 不要 / no /
 * nope / don't / not needed.
 */
export function isShortNegative(content: string): boolean {
  const cleaned = stripOuterPunctuation(content);
  if (!cleaned) return false;
  if (cleaned.length > 24) return false;
  const all = [...ZH_NEGATIVE, ...EN_NEGATIVE];
  return all.some((re) => re.test(cleaned));
}

/**
 * Regular expression matching common SQL write/DDL keywords.
 * Shared between AiAssistant.vue and tests so the regex stays in one place.
 */
export const WRITE_SQL_KEYWORD_RE = /\b(insert|update|delete|replace|merge|create|alter|drop|truncate|rename|grant|revoke)\b/i;

/**
 * Returns true when the text contains SQL write or DDL keywords.
 */
export function containsWriteSql(text: string): boolean {
  return WRITE_SQL_KEYWORD_RE.test(text);
}

/**
 * Returns true when the assistant message ends with an action proposal AND
 * the message as a whole contains write/DDL SQL keywords.
 *
 * Check order:
 * 1. Last non-empty line must be an action proposal (question mark + ask
 *    phrase + action verb).
 * 2. The *entire message* (not just the last line) must contain at least
 *    one write/DDL keyword (INSERT, DELETE, CREATE, etc.).
 *
 * This two-step check handles the common pattern where the model outputs
 * a SQL code block followed by a generic confirmation question like
 * "需要我执行这条 SQL 吗？" — the write keywords live in the code block,
 * not in the last line.
 *
 * **Safety rule**: the last line (the proposal itself) MUST explicitly
 * reference the write SQL or the write operation.  A message where the
 * last line asks about a read operation but a write keyword appears
 * elsewhere is NOT treated as a write-SQL proposal — the assistant is
 * offering a read, not a write.  Without this rule, confirming "need me
 * to query the remaining records?" could inadvertently grant write
 * permission because DELETE appeared earlier in the message.
 */
export function looksLikeWriteSqlProposal(content: string): boolean {
  if (!content) return false;
  const lastLine = lastNonEmptyLine(content);
  if (!lastLine) return false;

  // Step 1: last line must be an action proposal (ask + action + question mark).
  if (!/[?？]\s*$/.test(lastLine)) return false;

  const isZh = containsChinese(lastLine);
  const askPhrases = isZh ? ZH_ASK_PHRASES : EN_ASK_PHRASES;
  const actionPhrases = isZh ? ZH_ACTION_PHRASES : EN_ACTION_PHRASES;

  if (!askPhrases.some((re) => re.test(lastLine))) return false;
  if (!actionPhrases.some((re) => re.test(lastLine))) return false;

  // Step 2: the full message must contain write/DDL SQL keywords somewhere
  // (typically in a code block or earlier sentence).
  if (!containsWriteSql(content)) return false;

  // Safety check: the last line must explicitly reference the write SQL or
  // the write/DDL operation itself.  A last line that asks about a read
  // ("查询"/"query") but happens to have a write keyword elsewhere in the
  // message is NOT a write-SQL proposal — it is a read proposal.
  // We check for three signals:
  //   a) The last line contains a write/DDL keyword directly, OR
  //   b) The last line contains a "this SQL" / "这条 SQL" reference that
  //      points back to the code block with the write SQL, OR
  //   c) The content has a SQL code block AND the last line mentions
  //      SQL / 执行 without specifying a different action (e.g. 查询).
  return lastLineMentionsWriteSql(lastLine, isZh, content);
}

/**
 * Returns true when the proposal line explicitly references a write/DDL
 * SQL operation (not a read-only action that happens to coexist with a
 * write keyword elsewhere in the message).
 */
function lastLineMentionsWriteSql(lastLine: string, isZh: boolean, fullContent: string): boolean {
  // Signal (a): last line contains a write/DDL keyword itself.
  if (containsWriteSql(lastLine)) return true;

  // Signal (b): last line references "this SQL" / "这条 SQL" / "这条语句"
  // pointing back to a code block that contains the write SQL.
  if (isZh) {
    if (/这条\s*SQL|这条\s*语句|这个\s*SQL|这段\s*SQL|上述\s*SQL|以上\s*SQL/.test(lastLine)) return true;
  } else {
    if (/this\s+SQL|the\s+SQL|this\s+statement|the\s+statement|this\s+query|the\s+query|above\s+SQL/.test(lastLine)) return true;
  }

  // Signal (c): message has a SQL code block AND the last line mentions
  // 执行/execute/run without specifying a different action like 查询/query.
  const hasCodeBlock = /```sql|```mysql|```postgresql|```sqlite|```tsql|```clickhouse|```\s*\n/.test(fullContent);
  if (hasCodeBlock) {
    if (isZh) {
      // Must mention 执行 or 运行 (execute/write-like), NOT 查询/查看 (read-like).
      if (/(?:执行|运行)/.test(lastLine) && !/(?:查询|查看|看看|看一下|读取)/.test(lastLine)) return true;
    } else {
      if (/\b(?:execute|run)\b/i.test(lastLine) && !/\b(?:query|read|fetch|retrieve|list|inspect|check|sample)\b/i.test(lastLine)) return true;
    }
  }

  return false;
}

/** Parameters for {@link shouldGrantWriteSqlOnShortAffirmative}. */
export interface WriteSqlGrantParams {
  mode: string;
  /** True when allowWriteSqlForNextRun has already been set, e.g. by the button path. */
  alreadyGranted: boolean;
  isProduction: boolean;
  userText: string;
  /**
   * Conversation history BEFORE the current user text was pushed.
   * The function scans backward from the last message, skipping
   * contextSummary entries, and stops at the first user message.
   */
  messages: Array<{ role: "user" | "assistant"; content: string; kind?: "contextSummary" }>;
}

/**
 * Pure-function extraction of the manual-confirmation gating logic used in
 * AiAssistant.vue send().  Returns true when the user just typed a short
 * affirmative reply (e.g. "可以"/"go ahead") and the most recent assistant
 * message before the user message is a write-SQL action proposal.
 *
 * Shared between the component and its unit tests so the two cannot drift.
 */
export function shouldGrantWriteSqlOnShortAffirmative(params: WriteSqlGrantParams): boolean {
  if (params.mode !== "agent" || params.isProduction || params.alreadyGranted) return false;
  if (!isShortAffirmative(params.userText)) return false;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const msg = params.messages[i];
    if (msg.kind === "contextSummary") continue;
    if (msg.role === "assistant" && msg.content && looksLikeWriteSqlProposal(msg.content)) return true;
    if (msg.role === "user") return false;
  }
  return false;
}
