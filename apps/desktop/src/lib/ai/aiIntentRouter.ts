import * as api from "@/lib/backend/api";
import type { AiCompletionRequest } from "@/lib/backend/tauri";
import { ASK_ACTIONS, AGENT_ACTIONS, defaultActionForMode, isValidActionForMode, type AiAction } from "@/lib/ai/ai";
import { isShortAffirmative, isShortNegative } from "@/lib/ai/aiProposalDetect";
import type { AiConfig } from "@/stores/settingsStore";
import type { AiAssistantMode } from "@/types/ai";

/**
 * Intent router behind the assistant's "Auto" picker entry (#9118).
 *
 * Two stages, cheapest first:
 *
 * 1. {@link routeIntentByRules} — pure zh/en heuristics, zero latency, zero
 *    network. Deliberately narrow in the style of `aiProposalDetect.ts`: an
 *    intent verb only routes when it co-occurs with an actionable object or a
 *    context signal (`hasCurrentSql` / `hasLastError`), so a chat message that
 *    merely contains "优化" does not hijack the request.
 * 2. {@link classifyIntentByLlm} — one lightweight plain-completion call
 *    (`ai_complete`, never the agent loop) that must answer with strict JSON.
 *    Its candidate set is the current mode's action list, minus the Agent-mode
 *    execution-capable actions unless the request explicitly asks to run, and
 *    any failure (timeout, transport error, unparsable or out-of-candidate
 *    answer) falls back to the mode's default `general`.
 *
 * The router only ever returns a concrete `AiAction`; "auto" never leaves the
 * UI, and the resolved action is always valid for the mode it was routed in.
 *
 * **Safety invariant**: in Agent mode an execution-capable action (`query`,
 * `executeAndExplain`) is only selectable when the request explicitly asks to
 * run/query/execute/fetch data. Ask-style intents (explain/optimize/convert/…)
 * map to non-executing actions only — Auto must never turn "explain this SQL"
 * into real database execution.
 */

/** Intents the rule layer can recognize before mapping them onto concrete actions. */
export type AiIntent = "generate" | "explain" | "optimize" | "fix" | "convert" | "sampleData" | "query" | "exploreSchema" | "executeAndExplain";

export interface AiIntentRouteInput {
  /** Raw text the user typed for this turn. */
  text: string;
  /** The editor has SQL/command text to work on. */
  hasCurrentSql: boolean;
  /** The last execution failed — an error report is a hard routing signal. */
  hasLastError: boolean;
  mode: AiAssistantMode;
}

/** Hard cap on the classifier timeout; a slow model must never delay the real request. */
export const INTENT_CLASSIFY_TIMEOUT_MS = 3000;
/** The classifier only needs the user's phrasing — never schema, results or error payloads. */
export const INTENT_CLASSIFY_MAX_TEXT_CHARS = 500;
const INTENT_CLASSIFY_MAX_TOKENS = 32;

// ---------------------------------------------------------------------------
// Rule layer
// ---------------------------------------------------------------------------

// Phrase sets are picked by script (the aiProposalDetect.ts convention) so a
// zh sentence and an en sentence never have to share one regex.
const ZH_GENERATE_VERBS = [/生成/, /写一?[条个段]/, /创建/, /构造/, /拼一?条/, /来一?条/, /产出/];
const EN_GENERATE_VERBS = [/\bgenerate\b/i, /\bwrite\b/i, /\bcreate\b/i, /\bproduce\b/i, /\bbuild\b/i, /\bdraft\b/i];
const ZH_SQL_OBJECTS = [/sql/i, /语句/, /查询/, /脚本/, /代码/, /命令/];
const EN_SQL_OBJECTS = [/\bsql\b/i, /\bquery\b/i, /\bstatement\b/i, /\bscript\b/i, /\bcode\b/i, /\bcommand\b/i];

const ZH_EXPLAIN_VERBS = [/解释/, /说明/, /讲解/, /说清楚/, /什么意思/, /含义/, /做什么用/];
const EN_EXPLAIN_VERBS = [/\bexplain\b/i, /\bwhat does\b/i, /\bwhat is this\b/i, /\bwalk me through\b/i, /\bdescribe\b/i, /\bmeaning\b/i];

const ZH_OPTIMIZE_VERBS = [/优化/, /调优/, /提升性能/, /性能/, /加速/, /更高效/, /慢/];
const EN_OPTIMIZE_VERBS = [/\boptimize\b/i, /\boptimise\b/i, /\btune\b/i, /\bspeed up\b/i, /\bslower\b/i, /\bfaster\b/i, /\bperformance\b/i, /\bslow\b/i];

// An error report, not a bare "why" question.
const ERROR_REPORT_RE = /报错|出错|错误|异常|执行失败|运行失败|失败|无法执行|fix|error|failed|failure|exception|stack ?trace/i;
const FIX_REQUEST_RE = /修复|修一下|修一修|改正|纠正|排查|调试|解决|fix|debug|troubleshoot|correct/i;

const ZH_CONVERT_VERBS = [/转成/, /转换/, /转为/, /改成/, /改为/, /换成/, /译成/, /翻译成/, /改写成/];
const EN_CONVERT_VERBS = [/\bconvert\b/i, /\btranslate\b/i, /\brewrite\b/i, /\bport\b/i, /\bmigrate\b/i];
// A named target dialect is what makes a convert request actionable.
const DIALECT_NAME_RE = /\b(?:mysql|mariadb|postgres(?:ql)?|oracle|sql\s*server|sqlserver|mssql|sqlite|clickhouse|duckdb|hive|spark|trino|presto|redshift|snowflake|bigquery|tidb|oceanbase|db2|firebird|pg)\b|达梦|人大金仓|金仓|高斯|opengauss|kingbase/i;

const SAMPLE_DATA_RE = /测试数据|样例数据|示例数据|模拟数据|假数据|造数据|填充数据|演示数据|测试用数据|(?:mock|sample|dummy|fake|test|seed|demo)\s+(?:数据|data|rows|records|values)/i;

const ZH_EXEC_VERBS = [/执行/, /运行/, /跑一下/, /跑跑/, /试跑/];
const EN_EXEC_VERBS = [/\brun\b/i, /\bexecute\b/i];
const ZH_RESULT_EXPLAIN_VERBS = [/解释/, /说明/, /讲解/, /分析结果/, /看看结果/];
const EN_RESULT_EXPLAIN_VERBS = [/\bexplain\b/i, /\bwalk me through\b/i, /\binterpret\b/i];

// Listing/showing tables is schema inspection, not a data query — anchoring it
// here keeps the broad query bucket from turning it into a SELECT (Agent+Auto).
const ZH_SCHEMA_PHRASES = [/有哪些?(?:表|字段|列|索引|视图|数据库)/, /有(?:哪|什么)些表/, /表结构/, /表清单/, /字段信息/, /列信息/, /元数据/, /数据库对象/, /列出(?:所有|全部|一下)?的?(?:(?:数据)?表|视图|索引|数据库)/, /显示(?:所有|全部|一下)?的?表/];
const EN_SCHEMA_PHRASES = [/\b(?:what|which|list|show|name)\s+(?:me\s+|us\s+)?(?:all\s+|the\s+|these\s+)?(?:tables|views|indexes|columns|databases)\b/i, /\btable (?:structure|schema|list)\b/i, /\bschema\b/i, /\bmetadata\b/i, /\bcolumns? (?:of|in|for)\b/i];

const ZH_QUERY_VERBS = [/查询/, /查一下/, /查查/, /查看/, /看看/, /看下/, /看一下/, /统计/, /获取/, /拉取/, /取出?/, /列出/, /找一下/, /有多少/, /多少条/, /数量/, /汇总/, /合计/, /排行/];
const EN_QUERY_VERBS = [/\bquery\b/i, /\bselect\b/i, /\bfetch\b/i, /\bretrieve\b/i, /\blist\b/i, /\bshow\b/i, /\bcount\b/i, /\bhow many\b/i, /\btotal\b/i, /\bsum\b/i, /\bget\b/i, /\bfind\b/i, /\btop\b/i];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function phrasesFor(isZh: boolean, zh: RegExp[], en: RegExp[]): RegExp[] {
  return isZh ? zh : en;
}

/**
 * Agent-mode actions that actually run statements against the database.
 *
 * **Safety invariant** (see `AGENT_INTENT_ACTIONS` and `intentCandidatesForMode`):
 * under Auto these may only be selected when the request EXPLICITLY asks to
 * run/query/execute data. An "explain this SQL" or "fix this error" request must
 * never trigger real execution — that would be an unrequested, potentially
 * expensive or sensitive query.
 */
const AGENT_EXECUTION_ACTIONS: ReadonlySet<AiAction> = new Set<AiAction>(["query", "executeAndExplain"]);

/**
 * Narrow, unambiguous "run it against the database" phrases — the ONLY signals
 * that may open the Agent execution gate (`requestsExplicitExecution`).
 *
 * Deliberately NOT derived from the rule layer's permissive data-request
 * vocabulary (`ZH/EN_QUERY_VERBS`): broad verbs such as show / get / find /
 * list (看看 / 获取 / 找一下 / 列出) also introduce explanation and
 * code-generation requests ("show me how to create a table", "get help
 * writing a stored procedure") that must never admit execution-capable
 * actions. The broad bucket may still route such a text onto `query`, but
 * `guardExecutionAction` re-checks every rule output against THIS gate, so in
 * Agent mode the permissive vocabulary can only ever end in a non-executing
 * action; the English data-object anchor additionally keeps bare "get/fetch"
 * from opening the gate without a target.
 */
// Unlike English, Chinese has no word boundary between `查询` and the subject.
// Require a nearby data target so static questions such as “查询语句的执行顺序”
// do not authorize database I/O merely because they contain that word.
const ZH_EXPLICIT_DATA_QUERY_RE = /(?:查询|查一下|查查|统计|汇总|合计|排行|有多少|多少条)[^。！？；]{0,24}(?:数据|记录|订单|用户|客户|日志|指标|行数|条数|数量|总数)/;
// `执行` and `运行` are also used in static questions such as “执行顺序” and
// “运行机制”. Only their imperative forms, or an explicit current-SQL target,
// authorize the execution actions.
const ZH_EXPLICIT_RUN_RE = /(?:执行一下|运行一下|跑一跑|跑跑|试跑|(?:执行|运行)(?:这(?:条|段)|当前|该|下列|下面|此)(?:\s*(?:SQL|语句|查询|脚本))?|(?:执行|运行)\s*(?:SQL|查询|脚本))/;
const NARROW_EXECUTION_PHRASES_ZH = [ZH_EXPLICIT_RUN_RE, ZH_EXPLICIT_DATA_QUERY_RE];
const NARROW_EXECUTION_PHRASES_EN = [...EN_EXEC_VERBS, /\b(?:query|fetch|pull|retrieve|get|select)\b[^.!?;]{0,40}?\b(?:data|database|db|rows?|records?|results?|entries|tables?|views?|orders?|users?|customers?|logs?|events?|metrics?)\b/i];

/**
 * True when the text explicitly asks to run/query/execute/fetch data, phrased
 * narrowly and unambiguously. This gate decides BOTH halves of the Agent
 * execution invariant: `guardExecutionAction` filters rule-layer outputs
 * against it, and `intentCandidatesForMode` drops the execution actions from
 * the classifier candidates when it is false.
 */
export function requestsExplicitExecution(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const isZh = /[一-鿿]/.test(trimmed);
  return anyMatch(phrasesFor(isZh, NARROW_EXECUTION_PHRASES_ZH, NARROW_EXECUTION_PHRASES_EN), trimmed);
}

/**
 * Agent mode has no Ask-only action, so a recognized Ask-style intent maps onto
 * the closest Agent-mode equivalent. Ask-style intents map onto **non-executing**
 * actions only: an explanation request uses `general` (whose contract answers
 * without instructing execution — `generate`'s SQL-first output contract would be
 * wrong for it) and error repair uses `generate` (corrected SQL, not executed).
 * Intentional execution (`query`, `executeAndExplain`) is reachable exclusively
 * through the data-request buckets, and `guardExecutionAction` re-checks each
 * hit against the narrow execution gate before it can leave the router.
 */
const AGENT_INTENT_ACTIONS: Record<AiIntent, AiAction> = {
  generate: "generate",
  query: "query",
  exploreSchema: "exploreSchema",
  executeAndExplain: "executeAndExplain",
  explain: "general",
  fix: "generate",
  optimize: "generate",
  convert: "generate",
  sampleData: "generate",
};

/**
 * Ask mode produces SQL only (never runs it), so data/schema intents map onto
 * `generate` and "run & explain" onto `explain`.
 */
const ASK_INTENT_ACTIONS: Record<AiIntent, AiAction> = {
  generate: "generate",
  explain: "explain",
  optimize: "optimize",
  fix: "fix",
  convert: "convert",
  sampleData: "sampleData",
  query: "generate",
  exploreSchema: "generate",
  executeAndExplain: "explain",
};

/** Concrete action for a detected intent in the given mode (always mode-valid). */
export function actionForIntent(intent: AiIntent, mode: AiAssistantMode): AiAction {
  return mode === "agent" ? AGENT_INTENT_ACTIONS[intent] : ASK_INTENT_ACTIONS[intent];
}

/**
 * Pure, zero-latency rule layer. Returns the concrete action for the current
 * mode, or `null` when nothing matched and the caller should fall through to the
 * classifier.
 *
 * Context signals outrank text keywords: a failed last run routes error reports
 * to `fix`, a named target dialect routes to `convert`, and sample/mock-data
 * wording routes to `sampleData` before any generic verb is considered. The
 * SQL-context-gated intents (`optimize`, `explain`) additionally require the
 * editor to hold SQL or the text to reference it, which is what keeps plain
 * conversation from being routed.
 *
 * Agent mode additionally enforces the execution invariant: an execution-capable
 * action is only ever returned by the explicit data-request buckets (the checks
 * below would already guarantee that; the wrapper's final guard makes it
 * structural so a future verb-set edit cannot silently reintroduce
 * "explain → execute").
 */
export function routeIntentByRules(input: AiIntentRouteInput): AiAction | null {
  return guardExecutionAction(routeByRulesUnchecked(input), input);
}

/** Rule decision table, before the Agent execution guard. */
function routeByRulesUnchecked(input: AiIntentRouteInput): AiAction | null {
  const text = input.text.trim();
  if (!text) return null;

  // A short "可以" / "go ahead" (or its negative, see `aiProposalDetect`) answers
  // the previous assistant proposal: it is a continuation, not a new request.
  // Route it to the mode default without spending a classifier call on it — the
  // conversation history, not this turn's wording, carries the earlier action.
  if (isShortAffirmative(text) || isShortNegative(text)) return defaultActionForMode(input.mode);

  const isZh = /[一-鿿]/.test(text);
  const sqlObject = anyMatch(phrasesFor(isZh, ZH_SQL_OBJECTS, EN_SQL_OBJECTS), text);
  const sqlContext = input.hasCurrentSql || sqlObject;

  // --- context signals (highest priority) ---
  if (input.hasLastError && ERROR_REPORT_RE.test(text)) return actionForIntent("fix", input.mode);
  if (anyMatch(phrasesFor(isZh, ZH_CONVERT_VERBS, EN_CONVERT_VERBS), text) && DIALECT_NAME_RE.test(text)) return actionForIntent("convert", input.mode);
  if (SAMPLE_DATA_RE.test(text)) return actionForIntent("sampleData", input.mode);

  // --- run & explain (before plain explain/query, which its wording also matches) ---
  if (anyMatch(phrasesFor(isZh, ZH_EXEC_VERBS, EN_EXEC_VERBS), text) && anyMatch(phrasesFor(isZh, ZH_RESULT_EXPLAIN_VERBS, EN_RESULT_EXPLAIN_VERBS), text)) {
    return actionForIntent("executeAndExplain", input.mode);
  }
  // --- schema inspection (before the generic query bucket) ---
  if (anyMatch(phrasesFor(isZh, ZH_SCHEMA_PHRASES, EN_SCHEMA_PHRASES), text)) return actionForIntent("exploreSchema", input.mode);

  // --- SQL-context-gated text operations ---
  if (sqlContext && anyMatch(phrasesFor(isZh, ZH_OPTIMIZE_VERBS, EN_OPTIMIZE_VERBS), text)) return actionForIntent("optimize", input.mode);
  if (sqlContext && anyMatch(phrasesFor(isZh, ZH_EXPLAIN_VERBS, EN_EXPLAIN_VERBS), text)) return actionForIntent("explain", input.mode);

  // --- explicit fix request without an error report yet ---
  if (anyMatch([FIX_REQUEST_RE], text) && (input.hasLastError || sqlContext)) return actionForIntent("fix", input.mode);

  // --- text production, then the permissive data-request bucket ---
  if (anyMatch(phrasesFor(isZh, ZH_GENERATE_VERBS, EN_GENERATE_VERBS), text) && sqlObject) return actionForIntent("generate", input.mode);
  if (anyMatch(phrasesFor(isZh, ZH_QUERY_VERBS, EN_QUERY_VERBS), text)) return actionForIntent("query", input.mode);

  return null;
}

/**
 * Enforcement of the Agent execution invariant on every rule-layer output: an
 * execution-capable action may only leave the router when the text matches the
 * narrow explicit-execution gate. The broad data-request bucket matches
 * permissive verbs (show/get/find/list, 看看/获取/找一下) whose explanatory or
 * code-generation uses ("show me how to create a table") must never execute —
 * the guard converts those hits to `null` so the request falls through to the
 * classifier with the execution actions already excluded from its candidates.
 */
function guardExecutionAction(action: AiAction | null, input: AiIntentRouteInput): AiAction | null {
  if (!action) return null;
  if (input.mode !== "agent" || !AGENT_EXECUTION_ACTIONS.has(action)) return action;
  return requestsExplicitExecution(input.text) ? action : null;
}

// ---------------------------------------------------------------------------
// Classifier layer
// ---------------------------------------------------------------------------

export interface AiIntentClassifyDeps {
  config: AiConfig;
  /**
   * Injected for tests. Defaults to the plain completion path
   * (`api.aiComplete` → `ai_complete`); the agent loop is never used here.
   */
  complete?: (request: AiCompletionRequest) => Promise<string>;
  timeoutMs?: number;
}

/**
 * Candidate actions for a mode, in menu order.
 *
 * In Agent mode the execution-capable actions are dropped unless the request
 * explicitly asks to run/query (`allowExecution`): the invariant is enforced by
 * removing them from the candidate list programmatically, not by asking the
 * model nicely in the prompt. `allowExecution` is deliberately NOT defaulted —
 * every caller has to decide, so a new call site cannot silently re-open
 * execution by forgetting the argument.
 */
export function intentCandidatesForMode(mode: AiAssistantMode, allowExecution: boolean): AiAction[] {
  const candidates = mode === "agent" ? [...AGENT_ACTIONS] : [...ASK_ACTIONS];
  if (mode === "agent" && !allowExecution) return candidates.filter((action) => !AGENT_EXECUTION_ACTIONS.has(action));
  return candidates;
}

function buildClassifierSystemPrompt(input: AiIntentRouteInput, candidates: AiAction[]): string {
  return [
    "You are an intent router for a SQL assistant inside a database IDE.",
    `Pick the single best action for the user's request. Mode: ${input.mode}.`,
    `Allowed actions: ${candidates.join(", ")}.`,
    `Context: the editor ${input.hasCurrentSql ? "contains SQL" : "is empty"}; the last execution ${input.hasLastError ? "failed" : "did not report an error"}.`,
    'Reply with JSON only: {"action":"<one allowed action>"}.',
    'If the request does not clearly match any action, reply {"action":"general"}.',
    "Never explain, never add other keys, never wrap the JSON in prose or code fences.",
  ].join("\n");
}

/**
 * Parse the classifier answer. Only an exact, mode-valid action is accepted —
 * anything else (prose, unknown action, malformed JSON) returns `null`.
 */
export function parseClassifierAction(raw: string, mode: AiAssistantMode): AiAction | null {
  const match = raw.match(/\{[^{}]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const action = (parsed as { action?: unknown }).action;
  if (typeof action !== "string") return null;
  const normalized = action.trim() as AiAction;
  return isValidActionForMode(normalized, mode) ? normalized : null;
}

/**
 * Slow path: one tiny completion call constrained to the current mode's action
 * list. Resolves to the mode default (`general`) on missing user text, timeout,
 * transport error, unparsable output or an out-of-candidate answer; it never
 * rejects, so a failing classifier can never break the real request.
 *
 * Agent mode drops the execution-capable actions from the candidate list unless
 * the request explicitly asks to run/query, and the parsed answer is checked
 * against that same list: the invariant is programmatic, so neither prompt
 * wording nor a hallucinated action name can make Auto execute SQL the user
 * never asked to run.
 */
export async function classifyIntentByLlm(input: AiIntentRouteInput, deps: AiIntentClassifyDeps): Promise<AiAction> {
  const fallback = defaultActionForMode(input.mode);
  // Nothing to classify (attachment-only send): the classifier would only see an
  // empty user message, which some providers reject outright. Skip the call and
  // take the same default the failure path would have produced.
  if (!input.text.trim()) return fallback;
  const candidates = intentCandidatesForMode(input.mode, requestsExplicitExecution(input.text));
  if (!candidates.length) return fallback;
  const complete = deps.complete ?? ((request: AiCompletionRequest) => api.aiComplete(request));
  const timeoutMs = deps.timeoutMs ?? INTENT_CLASSIFY_TIMEOUT_MS;
  const request: AiCompletionRequest = {
    config: deps.config,
    systemPrompt: buildClassifierSystemPrompt(input, candidates),
    // No conversation history and no schema/error payload: the phrasing alone
    // is what the classifier needs, and nothing else leaves the client.
    messages: [{ role: "user", content: input.text.trim().slice(0, INTENT_CLASSIFY_MAX_TEXT_CHARS) }],
    maxTokens: INTENT_CLASSIFY_MAX_TOKENS,
  };

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve("");
    }, timeoutMs);
  });

  try {
    const answer = await Promise.race([Promise.resolve(complete(request)).catch(() => ""), timeout]);
    if (timedOut) return fallback;
    const parsed = parseClassifierAction(answer, input.mode);
    return parsed && candidates.includes(parsed) ? parsed : fallback;
  } catch {
    // `complete` threw synchronously.
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two-stage routing entry point: rules first, classifier second, `general` last.
 * Always resolves to a concrete action valid for `input.mode`.
 */
export async function routeIntent(input: AiIntentRouteInput, deps: AiIntentClassifyDeps): Promise<AiAction> {
  const byRules = routeIntentByRules(input);
  if (byRules) return byRules;
  return classifyIntentByLlm(input, deps);
}
