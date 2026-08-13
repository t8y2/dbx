/**
 * Redis command autocompletion shared by the query editor and terminal input.
 * It mirrors the shape of `elasticsearchCompletion.ts` so the editor's
 * completion pipeline can dispatch to it.
 *
 * Candidates and their displayed metadata come exclusively from the connected
 * server's `COMMAND DOCS` (or legacy `COMMAND`) response. Safety enforcement
 * remains in the command execution path and is not inferred for completion.
 */
import type { RedisCommandArgument, RedisCommandDocumentation, RedisCommandKeySpec } from "@/lib/redis/redisCommandDocs";
import { tokenizeRedisLine } from "@/lib/redis/redisCommandTokenizer";

export interface RedisCompletionItem {
  label: string;
  type: "keyword" | "text"; // command/subcommand=keyword, key name=text
  detail?: string; // single-line, e.g. "string · confirm"
  info?: string; // multi-line: Group / Arity / Safety
  summary?: string;
  since?: string;
  apply?: string;
  appendSpace?: boolean;
  boost: number;
}

export interface RedisCompletionContext {
  mode: "command" | "subcommand" | "argument";
  prefix: string;
  /** Absolute document offset where the completion starts. */
  from: number;
  /** Upper-cased main command already typed, when known. */
  mainCommand?: string;
  /** Resolved command head, including a subcommand when applicable. */
  commandName?: string;
  /** In argument mode: 0-based index of the argument position (after the command head). */
  argumentIndex?: number;
  /** Completed argument values before the current cursor position. */
  argumentValues?: string[];
}

export interface RedisCompletionInput {
  keys?: string[];
  /** Commands reported by the connected Redis server through `COMMAND DOCS` or `COMMAND`. */
  commands: readonly RedisCommandDocumentation[];
}

// ---- Server-reported command index ----

interface CompletionCommandEntry {
  name: string;
  arity: number;
  group: string;
  summary?: string;
  since?: string;
  keySpecs: readonly RedisCommandKeySpec[];
  arguments: readonly RedisCommandArgument[];
}

interface CompletionIndex {
  commands: Map<string, CompletionCommandEntry>;
  mainCommands: CompletionCommandEntry[];
  subcommands: Map<string, CompletionCommandEntry[]>;
}

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

function createCompletionIndex(commandDocs: readonly RedisCommandDocumentation[]): CompletionIndex {
  const commands = new Map<string, CompletionCommandEntry>();
  for (const doc of commandDocs) {
    const name = doc.name.trim().toUpperCase();
    if (!name) continue;
    commands.set(name, {
      name,
      arity: doc.arity ?? 0,
      group: doc.group ?? "unknown",
      summary: doc.summary,
      since: doc.since,
      keySpecs: doc.keySpecs,
      arguments: doc.arguments ?? [],
    });
  }

  const mainCommands = new Map<string, CompletionCommandEntry>();
  const subcommands = new Map<string, CompletionCommandEntry[]>();
  for (const entry of commands.values()) {
    const tokens = entry.name.split(" ");
    const main = tokens[0]!;
    if (!mainCommands.has(main)) {
      mainCommands.set(main, commands.get(main) ?? { ...entry, name: main, summary: undefined, since: undefined });
    }
    for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex++) {
      const parent = tokens.slice(0, tokenIndex).join(" ");
      const childName = tokens.slice(0, tokenIndex + 1).join(" ");
      const entries = subcommands.get(parent) ?? [];
      if (!entries.some((candidate) => candidate.name === childName)) {
        entries.push(commands.get(childName) ?? { ...entry, name: childName, summary: undefined, since: undefined });
      }
      subcommands.set(parent, entries);
    }
  }

  return {
    commands,
    mainCommands: [...mainCommands.values()],
    subcommands,
  };
}

const completionIndexes = new WeakMap<ReadonlyArray<RedisCommandDocumentation>, CompletionIndex>();

function completionIndex(input: Pick<RedisCompletionInput, "commands">): CompletionIndex {
  const cached = completionIndexes.get(input.commands);
  if (cached) return cached;
  const index = createCompletionIndex(input.commands);
  completionIndexes.set(input.commands, index);
  return index;
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function buildSpecDetail(entry: CompletionCommandEntry): string {
  return entry.group;
}

function buildSpecInfo(entry: CompletionCommandEntry, label: string): string {
  const info = [];
  if (entry.summary) info.push(entry.summary);
  info.push(`Command: ${label}`, `Group: ${entry.group}`, `Arity: ${describeArity(entry.arity)}`);
  if (entry.since) info.push(`Since: ${entry.since}`);
  return info.join("\n");
}

function boostFor(entry: CompletionCommandEntry): number {
  return GROUP_BOOST[entry.group] ?? 90;
}

// ---- Context parsing ----

export function getRedisCompletionContext(text: string, cursor: number, input: Pick<RedisCompletionInput, "commands">): RedisCompletionContext {
  const index = completionIndex(input);
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf("\n", safeCursor - 1) + 1;
  const beforeCursor = text.slice(lineStart, safeCursor);

  const tokenized = tokenizeRedisLine(beforeCursor);
  const endsWithSpace = beforeCursor.length > 0 && /\s$/.test(beforeCursor);
  const currentToken = endsWithSpace ? undefined : tokenized.argv[tokenized.argv.length - 1];
  const currentWord = currentToken?.value ?? "";
  const from = currentToken ? lineStart + currentToken.startColumn - 1 : safeCursor;
  const tokens = tokenized.argv.map((token) => token.value);
  const typedTokens = endsWithSpace ? tokens : tokens.slice(0, -1);

  // No command yet (or typing the very first token).
  if (typedTokens.length === 0) {
    return { mode: "command", prefix: currentWord, from };
  }

  const normalizedTokens = typedTokens.map((token) => token.toUpperCase());
  const main = normalizedTokens[0]!;
  const commandPrefix = normalizedTokens.join(" ");

  // Command docs can nest subcommands more than one level deep. Treat every
  // documented command prefix as a potential next-token completion context.
  if (index.subcommands.has(commandPrefix)) {
    return { mode: "subcommand", prefix: currentWord, from, mainCommand: main, commandName: commandPrefix };
  }

  let commandName: string | undefined;
  for (let tokenCount = normalizedTokens.length; tokenCount > 0; tokenCount--) {
    const candidate = normalizedTokens.slice(0, tokenCount).join(" ");
    if (!index.commands.has(candidate)) continue;
    commandName = candidate;
    break;
  }
  const commandHeadTokens = commandName ? commandName.split(" ").length : normalizedTokens.length;
  const argumentIndex = Math.max(typedTokens.length - commandHeadTokens, 0);
  return {
    mode: "argument",
    prefix: currentWord,
    from,
    mainCommand: main,
    commandName,
    argumentIndex,
    argumentValues: typedTokens.slice(commandHeadTokens),
  };
}

// ---- Item builders ----

function commandItems(index: CompletionIndex, prefix: string): RedisCompletionItem[] {
  const items = index.mainCommands
    .filter((entry) => matchesPrefix(entry.name, prefix))
    .map((entry) => ({
      label: entry.name,
      type: "keyword" as const,
      detail: buildSpecDetail(entry),
      info: buildSpecInfo(entry, entry.name),
      summary: entry.summary,
      since: entry.since,
      boost: boostFor(entry),
    }));
  return items.sort((a, b) => b.boost - a.boost);
}

function subcommandItems(index: CompletionIndex, commandPrefix: string, prefix: string): RedisCompletionItem[] {
  const items = (index.subcommands.get(commandPrefix) ?? [])
    .filter((entry) => matchesPrefix(entry.name.slice(commandPrefix.length + 1), prefix))
    .map((entry) => ({
      label: entry.name.slice(commandPrefix.length + 1),
      type: "keyword" as const,
      detail: buildSpecDetail(entry),
      info: buildSpecInfo(entry, entry.name),
      summary: entry.summary,
      since: entry.since,
      boost: boostFor(entry),
    }));
  return items.sort((a, b) => b.boost - a.boost);
}

function redisArgumentApply(value: string): string {
  if (value && !/[\s"']/.test(value) && !value.endsWith(";")) return value;
  return `"${value.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t").replaceAll('"', '\\"')}"`;
}

function keyItems(prefix: string, keys: string[]): RedisCompletionItem[] {
  if (!prefix) {
    // No partial key typed yet: offer a bounded sample (sorted) so the menu isn't empty.
    return keys.slice(0, 100).map((key) => ({
      label: key,
      type: "text" as const,
      detail: "key",
      apply: redisArgumentApply(key),
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
      apply: redisArgumentApply(key),
      boost: key.toLowerCase().startsWith(prefix.toLowerCase()) ? 70 : 55,
    }));
}

interface ArgumentTransition {
  to: number;
  token?: string;
  argument?: RedisCommandArgument;
}

interface ArgumentGrammar {
  start: number;
  transitions: Map<number, ArgumentTransition[]>;
}

const argumentGrammars = new WeakMap<ReadonlyArray<RedisCommandArgument>, ArgumentGrammar>();

function argumentGrammar(arguments_: readonly RedisCommandArgument[]): ArgumentGrammar {
  const cached = argumentGrammars.get(arguments_);
  if (cached) return cached;
  const transitions = new Map<number, ArgumentTransition[]>();
  let nextState = 0;
  const state = () => nextState++;
  const add = (from: number, transition: ArgumentTransition) => transitions.set(from, [...(transitions.get(from) ?? []), transition]);
  const epsilon = (from: number, to: number) => add(from, { to });

  const compileSequence = (arguments_: readonly RedisCommandArgument[], start: number, end: number) => {
    let from = start;
    arguments_.forEach((argument, index) => {
      const to = index === arguments_.length - 1 ? end : state();
      compileArgument(argument, from, to);
      from = to;
    });
    if (arguments_.length === 0) epsilon(start, end);
  };
  const compileContent = (argument: RedisCommandArgument, start: number, end: number) => {
    if (argument.type === "pure-token") {
      epsilon(start, end);
    } else if (argument.type === "block") {
      compileSequence(argument.arguments ?? [], start, end);
    } else if (argument.type === "oneof") {
      for (const child of argument.arguments ?? []) compileArgument(child, start, end);
    } else if (argument.enum?.length) {
      for (const value of argument.enum) add(start, { to: end, token: value.toUpperCase(), argument });
    } else {
      add(start, { to: end, argument });
    }
  };
  const compileCore = (argument: RedisCommandArgument, start: number, end: number) => {
    if (!argument.token) return compileContent(argument, start, end);
    const contentStart = state();
    add(start, { to: contentStart, token: argument.token.toUpperCase(), argument });
    compileContent(argument, contentStart, end);
  };
  function compileArgument(argument: RedisCommandArgument, start: number, end: number) {
    if (argument.optional) epsilon(start, end);
    if (!argument.multiple) {
      compileCore(argument, start, end);
      return;
    }
    if (argument.token && !argument.multipleToken && argument.type !== "pure-token") {
      const contentStart = state();
      const repeated = state();
      add(start, { to: contentStart, token: argument.token.toUpperCase(), argument });
      compileContent(argument, contentStart, repeated);
      epsilon(repeated, end);
      epsilon(repeated, contentStart);
      return;
    }
    const repeated = state();
    compileCore(argument, start, repeated);
    epsilon(repeated, end);
    epsilon(repeated, start);
  }

  const start = state();
  const end = state();
  compileSequence(arguments_, start, end);
  const grammar = { start, transitions };
  argumentGrammars.set(arguments_, grammar);
  return grammar;
}

function argumentTokenItems(entry: CompletionCommandEntry, values: readonly string[], prefix: string): RedisCompletionItem[] {
  if (entry.arguments.length === 0) return [];
  const { start, transitions } = argumentGrammar(entry.arguments);
  const closure = (states: ReadonlySet<number>) => {
    const result = new Set(states);
    const pending = [...states];
    while (pending.length) {
      for (const transition of transitions.get(pending.pop()!) ?? []) {
        if (transition.token || transition.argument || result.has(transition.to)) continue;
        result.add(transition.to);
        pending.push(transition.to);
      }
    }
    return result;
  };

  let active = closure(new Set([start]));
  for (const value of values) {
    const next = new Set<number>();
    for (const current of active) {
      for (const transition of transitions.get(current) ?? []) {
        if (transition.token ? transition.token === value.toUpperCase() : transition.argument) next.add(transition.to);
      }
    }
    active = closure(next);
    if (active.size === 0) return [];
  }

  const items = new Map<string, RedisCompletionItem>();
  for (const current of active) {
    for (const transition of transitions.get(current) ?? []) {
      if (!transition.token || !matchesPrefix(transition.token, prefix)) continue;
      const argument = transition.argument;
      const info = [argument?.summary, entry.summary, argument?.since ? `Since: ${argument.since}` : undefined].filter(Boolean).join("\n");
      items.set(transition.token, {
        label: transition.token,
        type: "keyword",
        detail: [argument?.name, argument?.type].filter(Boolean).join(" · "),
        info: info || undefined,
        apply: transition.token,
        appendSpace: true,
        boost: 80,
      });
    }
  }
  return [...items.values()];
}

export function buildRedisCompletionItemsFromContext(context: RedisCompletionContext, input: RedisCompletionInput): RedisCompletionItem[] {
  const index = completionIndex(input);
  if (context.mode === "command") return commandItems(index, context.prefix);
  if (context.mode === "subcommand" && context.commandName) {
    return subcommandItems(index, context.commandName, context.prefix);
  }
  if (context.mode === "argument" && takesKeyArgument(context.commandName, input, context.argumentIndex, context.argumentValues)) {
    return keyItems(context.prefix, input.keys ?? []);
  }
  if (context.mode === "argument" && context.commandName) {
    const entry = index.commands.get(context.commandName);
    if (entry) return argumentTokenItems(entry, context.argumentValues ?? [], context.prefix);
  }
  return [];
}

function keySpecStart(spec: RedisCommandKeySpec, argumentIndex: number, argumentsBeforeCursor: readonly string[]): number | undefined {
  const beginSearch = spec.beginSearch;
  if (beginSearch.type === "index") return beginSearch.index - 1;
  const searchStart = beginSearch.startFrom >= 0 ? Math.max(0, beginSearch.startFrom - 1) : Math.max(0, Math.max(argumentsBeforeCursor.length, argumentIndex + 1) + beginSearch.startFrom);
  if (beginSearch.startFrom < 0) {
    for (let index = Math.min(searchStart, argumentsBeforeCursor.length - 1); index >= 0; index--) {
      if (argumentsBeforeCursor[index]?.toUpperCase() === beginSearch.keyword) return index + 1;
    }
    return undefined;
  }
  const keywordIndex = argumentsBeforeCursor.findIndex((argument, index) => index >= searchStart && argument.toUpperCase() === beginSearch.keyword);
  return keywordIndex < 0 ? undefined : keywordIndex + 1;
}

function keySpecMatchesArgument(spec: RedisCommandKeySpec, argumentIndex: number, argumentsBeforeCursor: readonly string[]): boolean {
  const start = keySpecStart(spec, argumentIndex, argumentsBeforeCursor);
  if (start == null || argumentIndex < start) return false;

  if (spec.findKeys.type === "range") {
    // Redis uses negative lastkey values relative to the final argv position.
    // The active argument is included so a completed tail argument is never
    // offered as a key (for example, BLPOP's timeout).
    const argumentCount = Math.max(argumentsBeforeCursor.length, argumentIndex + 1);
    let last = spec.findKeys.lastKey < 0 ? argumentCount + spec.findKeys.lastKey : start + spec.findKeys.lastKey;
    if (argumentIndex === start && argumentsBeforeCursor.length === start) last = start;
    if (spec.findKeys.lastKey === -1 && spec.findKeys.limit > 1) {
      const completedAfterStart = Math.max(0, argumentsBeforeCursor.length - start);
      // With no key entered yet, the first key is unambiguous. Once arguments
      // exist, `limit` separates the key list from its equally sized tail.
      last = completedAfterStart === 0 ? start : start + (Math.ceil(completedAfterStart / spec.findKeys.limit) - 1) * spec.findKeys.keyStep;
    }
    return argumentIndex <= last && (argumentIndex - start) % spec.findKeys.keyStep === 0;
  }

  const keyCountArgument = argumentsBeforeCursor[start + spec.findKeys.keyNumIndex];
  if (!keyCountArgument || !/^\d+$/.test(keyCountArgument)) return false;
  const keyCount = Number(keyCountArgument);
  const firstKey = start + spec.findKeys.firstKey;
  const lastKey = firstKey + Math.max(0, keyCount - 1) * spec.findKeys.keyStep;
  return argumentIndex >= firstKey && argumentIndex <= lastKey && (argumentIndex - firstKey) % spec.findKeys.keyStep === 0;
}

export function buildRedisCompletionItems(text: string, cursor: number, input: RedisCompletionInput): RedisCompletionItem[] {
  return buildRedisCompletionItemsFromContext(getRedisCompletionContext(text, cursor, input), input);
}

/** True when the server's key specs identify the active argument as a key. */
export function takesKeyArgument(commandName: string | undefined, input: Pick<RedisCompletionInput, "commands">, argumentIndex = 0, argumentsBeforeCursor: readonly string[] = []): boolean {
  if (!commandName || argumentIndex < 0) return false;
  const command = completionIndex(input).commands.get(commandName.toUpperCase());
  return command?.keySpecs.some((spec) => keySpecMatchesArgument(spec, argumentIndex, argumentsBeforeCursor)) ?? false;
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
