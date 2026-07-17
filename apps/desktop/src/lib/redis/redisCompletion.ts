/**
 * Redis command autocompletion for the query editor. Mirrors the shape of
 * `elasticsearchCompletion.ts` so the editor's completion pipeline (the single
 * `autocompletion({ override })` in QueryEditor.vue) can dispatch to it.
 *
 * Data source: the static `REDIS_COMMAND_TABLE` (built for diagnostics). Keys
 * are UPPER CASE command names; two-token subcommands are keyed as `"MAIN SUB"`
 * (e.g. `"XGROUP CREATE"`). We split those into a main-name index + subcommand
 * index here.
 */
import { REDIS_COMMAND_TABLE } from "@/lib/redis/redisCommandTable";
import type { RedisCommandSpec } from "@/lib/redis/redisCommandTable";

export interface RedisCompletionItem {
  label: string;
  type: "keyword" | "text"; // command/subcommand=keyword, key name=text
  detail?: string; // single-line, e.g. "string · confirm"
  info?: string; // multi-line: Group / Arity / Safety
  apply?: string;
  boost: number;
}

export interface RedisCompletionContext {
  mode: "command" | "subcommand" | "argument";
  prefix: string;
  /** Absolute document offset where the completion starts. */
  from: number;
  /** Upper-cased main command already typed, when known. */
  mainCommand?: string;
  /** In argument mode: 0-based index of the argument position (after the command head). */
  argumentIndex?: number;
}

export interface RedisCompletionInput {
  keys?: string[];
}

// ---- Static indexes derived from the command table ----

interface MainCommandEntry {
  name: string;
  spec: RedisCommandSpec;
}

interface SubcommandEntry {
  main: string;
  sub: string;
  spec: RedisCommandSpec;
}

const MAIN_COMMANDS: MainCommandEntry[] = [];
const SUBCOMMANDS: SubcommandEntry[] = [];
const SUBCOMMAND_MAINS = new Set<string>();

for (const [key, spec] of Object.entries(REDIS_COMMAND_TABLE)) {
  const space = key.indexOf(" ");
  if (space < 0) {
    MAIN_COMMANDS.push({ name: key, spec });
  } else {
    const main = key.slice(0, space);
    const sub = key.slice(space + 1);
    SUBCOMMANDS.push({ main, sub, spec });
    SUBCOMMAND_MAINS.add(main);
    // A main command that only has subcommand forms still needs a main-name
    // entry so the user can complete the main token first.
    if (!REDIS_COMMAND_TABLE[main]) MAIN_COMMANDS.push({ name: main, spec });
  }
}

// Groups whose first argument is a key name (enable key completion there).
const KEY_ARGUMENT_GROUPS = new Set(["string", "generic", "list", "hash", "set", "zset", "bitmap", "hyperloglog", "geo", "stream"]);

// Commands that accept a variadic list of keys (keep suggesting keys beyond the
// first argument slot). Most key commands take exactly one key; these keep going.
const MULTI_KEY_COMMANDS = new Set(["DEL", "UNLINK", "EXISTS", "TOUCH", "MGET"]);

// Boost tuning: common groups surface higher.
const GROUP_BOOST: Record<string, number> = {
  string: 110,
  generic: 108,
  connection: 100,
  server: 96,
};

function describeArity(arity: number): string {
  if (arity > 0) {
    const n = arity - 1;
    return `exactly ${n} argument${n === 1 ? "" : "s"}`;
  }
  if (arity < 0) {
    const n = -arity - 1;
    return `at least ${n} argument${n === 1 ? "" : "s"}`;
  }
  return "variable arguments";
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function buildSpecDetail(spec: RedisCommandSpec): string {
  return spec.safety === "allowed" ? spec.group : `${spec.group} · ${spec.safety}`;
}

function buildSpecInfo(spec: RedisCommandSpec, label: string): string {
  return [`Command: ${label}`, `Group: ${spec.group}`, `Arity: ${describeArity(spec.arity)}`, `Safety: ${spec.safety}`].join("\n");
}

function boostFor(spec: RedisCommandSpec): number {
  return GROUP_BOOST[spec.group] ?? 90;
}

// ---- Context parsing ----

export function getRedisCompletionContext(text: string, cursor: number): RedisCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf("\n", safeCursor - 1) + 1;
  const beforeCursor = text.slice(lineStart, safeCursor);

  // Tokenize the part before the cursor by whitespace.
  const tokens = beforeCursor.trimStart().length === 0 ? [] : beforeCursor.trim().split(/\s+/);
  const endsWithSpace = beforeCursor.length > 0 && /\s$/.test(beforeCursor);

  // Current word being typed (no trailing space yet).
  const currentWord = endsWithSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const wordStartFromEnd = currentWord.length;
  const from = safeCursor - wordStartFromEnd;

  const typedTokens = endsWithSpace ? tokens : tokens.slice(0, -1);

  // No command yet (or typing the very first token).
  if (typedTokens.length === 0) {
    return { mode: "command", prefix: currentWord, from };
  }

  const main = typedTokens[0]!.toUpperCase();

  // First token done + space → maybe a subcommand of a command that has them.
  if (typedTokens.length === 1 && SUBCOMMAND_MAINS.has(main)) {
    return { mode: "subcommand", prefix: currentWord, from, mainCommand: main };
  }

  // Past the command (and any subcommand slot) → an argument. Track which
  // argument position the cursor is at so we only suggest key names for the
  // first key argument (e.g. GET <key>, not after the key is filled in).
  const commandHeadTokens = typedTokens.length >= 2 && REDIS_COMMAND_TABLE[`${main} ${typedTokens[1]!.toUpperCase()}`] ? 2 : 1;
  const argumentIndex = Math.max(typedTokens.length - commandHeadTokens, 0);
  return { mode: "argument", prefix: currentWord, from, mainCommand: main, argumentIndex };
}

// ---- Item builders ----

function commandItems(prefix: string): RedisCompletionItem[] {
  const items = MAIN_COMMANDS.filter((entry) => matchesPrefix(entry.name, prefix)).map((entry) => ({
    label: entry.name,
    type: "keyword" as const,
    detail: buildSpecDetail(entry.spec),
    info: buildSpecInfo(entry.spec, entry.name),
    boost: boostFor(entry.spec),
  }));
  return items.sort((a, b) => b.boost - a.boost);
}

function subcommandItems(main: string, prefix: string): RedisCompletionItem[] {
  const items = SUBCOMMANDS.filter((entry) => entry.main === main && matchesPrefix(entry.sub, prefix)).map((entry) => ({
    label: entry.sub,
    type: "keyword" as const,
    detail: buildSpecDetail(entry.spec),
    info: buildSpecInfo(entry.spec, `${main} ${entry.sub}`),
    boost: boostFor(entry.spec),
  }));
  return items.sort((a, b) => b.boost - a.boost);
}

function keyItems(prefix: string, keys: string[]): RedisCompletionItem[] {
  if (!prefix) {
    // No partial key typed yet: offer a bounded sample (sorted) so the menu isn't empty.
    return keys.slice(0, 100).map((key) => ({
      label: key,
      type: "text" as const,
      detail: "key",
      boost: 60,
    }));
  }
  return keys
    .filter((key) => key.toLowerCase().includes(prefix.toLowerCase()))
    .slice(0, 100)
    .map((key) => ({
      label: key,
      type: "text" as const,
      detail: "key",
      boost: key.toLowerCase().startsWith(prefix.toLowerCase()) ? 70 : 55,
    }));
}

export function buildRedisCompletionItemsFromContext(context: RedisCompletionContext, input: RedisCompletionInput = {}): RedisCompletionItem[] {
  if (context.mode === "command") return commandItems(context.prefix);
  if (context.mode === "subcommand" && context.mainCommand) {
    return subcommandItems(context.mainCommand, context.prefix);
  }
  // argument mode: offer key names at the key-argument slot only. Most key
  // commands take a single key (first slot); variadic key-list commands
  // (DEL/UNLINK/EXISTS/...) keep suggesting at every slot.
  if (context.mode === "argument" && takesKeyArgument(context.mainCommand) && shouldSuggestKeyAt(context.mainCommand, context.argumentIndex)) {
    return keyItems(context.prefix, input.keys ?? []);
  }
  return [];
}

function shouldSuggestKeyAt(mainCommand: string | undefined, argumentIndex: number | undefined): boolean {
  if (argumentIndex == null) return false;
  if (mainCommand && MULTI_KEY_COMMANDS.has(mainCommand)) return true;
  return argumentIndex === 0;
}

export function buildRedisCompletionItems(text: string, cursor: number, input: RedisCompletionInput = {}): RedisCompletionItem[] {
  return buildRedisCompletionItemsFromContext(getRedisCompletionContext(text, cursor), input);
}

/** True when the main command's first argument is a key (by group heuristic). */
export function takesKeyArgument(mainCommand?: string): boolean {
  if (!mainCommand) return false;
  const spec = REDIS_COMMAND_TABLE[mainCommand];
  if (spec) return KEY_ARGUMENT_GROUPS.has(spec.group);
  // A main that only exists via subcommands (e.g. XGROUP, CONFIG): treat stream/cluster
  // subcommand roots as key-taking only for the stream group, conservatively.
  return false;
}

export function shouldAutoOpenRedisCompletion(text: string, cursor: number): boolean {
  const previousChar = text[cursor - 1];
  if (!previousChar) return false;
  if (/[\n\r]/.test(previousChar)) return false;
  // Open while typing command names or key names (letters/digits/_/:/./-).
  if (/[\w:*.-]/.test(previousChar)) return true;
  // Just typed a space after a command → open to suggest subcommands / keys.
  if (/\s/.test(previousChar)) return true;
  return false;
}

export function getRedisCompletionResultValidFor(): RegExp {
  return /[\w:*.-]*$/;
}
