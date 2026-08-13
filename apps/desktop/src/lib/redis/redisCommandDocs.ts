/**
 * Normalizes `COMMAND DOCS` maps emitted by the Rust bridge. RESP3 maps are
 * serialized as `{ key, value }` entries; RESP2 maps are alternating arrays.
 */
export interface RedisCommandDocumentation {
  name: string;
  summary?: string;
  since?: string;
  group?: string;
  arity?: number;
  keySpecs: RedisCommandKeySpec[];
  arguments?: RedisCommandArgument[];
}

/** The recursive command grammar Redis publishes through `COMMAND DOCS`. */
export interface RedisCommandArgument {
  name: string;
  token?: string;
  type?: string;
  summary?: string;
  since?: string;
  optional?: boolean;
  multiple?: boolean;
  multipleToken?: boolean;
  enum?: string[];
  arguments?: RedisCommandArgument[];
}

/** The key-position information Redis publishes through `COMMAND DOCS`. */
export interface RedisCommandKeySpec {
  beginSearch: { type: "index"; index: number } | { type: "keyword"; keyword: string; startFrom: number };
  findKeys: { type: "range"; lastKey: number; keyStep: number; limit: number } | { type: "keynum"; keyNumIndex: number; firstKey: number; keyStep: number };
}

type RedisRecord = Record<string, unknown>;

function mapEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    // RESP2 represents a map as an alternating key/value array, while RESP3
    // reaches the bridge as `{ key, value }` entries.
    if (value.length > 0 && value.length % 2 === 0 && value.every((item, index) => index % 2 !== 0 || typeof item === "string")) {
      const entries: Array<[string, unknown]> = [];
      for (let index = 0; index < value.length; index += 2) {
        entries.push([value[index] as string, value[index + 1]]);
      }
      return entries;
    }
    const entries: Array<[string, unknown]> = [];
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "string") {
        entries.push([item[0], item[1]]);
        continue;
      }
      if (item && typeof item === "object" && "key" in item && "value" in item && typeof item.key === "string") {
        entries.push([item.key, item.value]);
      }
    }
    return entries;
  }
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

function recordFromMap(value: unknown): RedisRecord {
  return Object.fromEntries(mapEntries(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function enabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function argumentFlags(value: unknown): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [])
      .filter((flag): flag is string => typeof flag === "string")
      .map((flag) => flag.trim().toLowerCase().replaceAll("-", "_"))
      .filter(Boolean),
  );
}

function normalizeCommandName(value: string): string {
  // Redis represents subcommands as `parent|child` in COMMAND metadata.
  return value.trim().replaceAll("|", " ").toUpperCase();
}

function commandArguments(value: unknown): RedisCommandArgument[] {
  const arguments_: RedisCommandArgument[] = [];
  for (const rawArgument of Array.isArray(value) ? value : []) {
    const argument = recordFromMap(rawArgument);
    const name = optionalString(argument.name);
    if (!name) continue;
    const token = optionalString(argument.token);
    const type = optionalString(argument.type);
    const summary = optionalString(argument.summary);
    const since = optionalString(argument.since);
    const nested = commandArguments(argument.arguments);
    const enumValues = (Array.isArray(argument.enum) ? argument.enum : []).filter((item): item is string => typeof item === "string" && item.length > 0);
    const flags = argumentFlags(argument.flags);
    arguments_.push({
      name,
      ...(token ? { token: token.toUpperCase() } : {}),
      ...(type ? { type } : {}),
      ...(summary ? { summary } : {}),
      ...(since ? { since } : {}),
      ...(enabledFlag(argument.optional) || flags.has("optional") ? { optional: true } : {}),
      ...(enabledFlag(argument.multiple) || flags.has("multiple") ? { multiple: true } : {}),
      ...(enabledFlag(argument.multiple_token) || flags.has("multiple_token") ? { multipleToken: true } : {}),
      ...(enumValues.length ? { enum: enumValues } : {}),
      ...(nested.length ? { arguments: nested } : {}),
    });
  }
  return arguments_;
}

function commandKeySpecs(value: unknown): RedisCommandKeySpec[] {
  const specs: RedisCommandKeySpec[] = [];
  for (const rawSpec of Array.isArray(value) ? value : []) {
    const spec = recordFromMap(rawSpec);
    const beginSearch = recordFromMap(spec.begin_search);
    const findKeys = recordFromMap(spec.find_keys);
    const beginSpec = recordFromMap(beginSearch.spec);
    const findSpec = recordFromMap(findKeys.spec);
    const beginType = optionalString(beginSearch.type);
    const findType = optionalString(findKeys.type);
    const keyStep = optionalNumber(findSpec.keystep);
    if (!beginType || !findType || !keyStep || keyStep < 1) continue;

    const begin = beginType === "index" ? optionalNumber(beginSpec.index) : beginType === "keyword" ? optionalString(beginSpec.keyword) : undefined;
    const normalizedBegin = typeof begin === "number" && begin > 0 ? { type: "index" as const, index: begin } : typeof begin === "string" ? { type: "keyword" as const, keyword: begin.toUpperCase(), startFrom: optionalNumber(beginSpec.startfrom) ?? 1 } : undefined;
    if (!normalizedBegin) continue;

    if (findType === "range") {
      const lastKey = optionalNumber(findSpec.lastkey);
      if (lastKey == null) continue;
      const limit = optionalNumber(findSpec.limit) ?? 0;
      if (limit < 0) continue;
      specs.push({ beginSearch: normalizedBegin, findKeys: { type: "range", lastKey, keyStep, limit } });
      continue;
    }
    if (findType === "keynum") {
      const keyNumIndex = optionalNumber(findSpec.keynumidx);
      const firstKey = optionalNumber(findSpec.firstkey);
      if (keyNumIndex == null || firstKey == null) continue;
      specs.push({ beginSearch: normalizedBegin, findKeys: { type: "keynum", keyNumIndex, firstKey, keyStep } });
    }
  }
  return specs;
}

function legacyCommandKeySpecs(value: readonly unknown[]): RedisCommandKeySpec[] {
  const firstKey = optionalNumber(value[3]);
  const lastKey = optionalNumber(value[4]);
  const keyStep = optionalNumber(value[5]);
  if (firstKey == null || firstKey < 1 || lastKey == null || keyStep == null || keyStep < 1) return [];
  // `COMMAND` reports an absolute last-key position, while `COMMAND DOCS`
  // range specs express it relative to the begin-search position.
  return [{ beginSearch: { type: "index", index: firstKey }, findKeys: { type: "range", lastKey: lastKey < 0 ? lastKey : Math.max(0, lastKey - firstKey), keyStep, limit: 0 } }];
}

function isCommandInfo(value: unknown): value is unknown[] {
  return Array.isArray(value) && typeof value[0] === "string" && optionalNumber(value[1]) !== undefined && Array.isArray(value[2]) && optionalNumber(value[3]) !== undefined;
}

/** Extract the completion-relevant subset of Redis' official `COMMAND DOCS` reply. */
export function parseRedisCommandDocumentation(value: unknown): RedisCommandDocumentation[] {
  const docs = new Map<string, RedisCommandDocumentation>();
  const collect = (rawDocs: unknown) => {
    for (const [rawName, rawDoc] of mapEntries(rawDocs)) {
      const name = normalizeCommandName(rawName);
      if (!name) continue;
      const doc = recordFromMap(rawDoc);
      const arguments_ = commandArguments(doc.arguments);
      docs.set(name, {
        name,
        summary: optionalString(doc.summary),
        since: optionalString(doc.since),
        group: optionalString(doc.group),
        arity: optionalNumber(doc.arity),
        keySpecs: commandKeySpecs(doc.key_specs),
        ...(arguments_.length ? { arguments: arguments_ } : {}),
      });
      // COMMAND DOCS returns only command families at the top level; their
      // concrete subcommands are nested in a map keyed as `parent|child`.
      if (doc.subcommands) collect(doc.subcommands);
    }
  };
  collect(value);
  return [...docs.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Extract command names from the legacy `COMMAND` reply, used on Redis before
 * 7.0 where `COMMAND DOCS` is unavailable. Its name and key-position fields
 * are stable across Redis 2.8+, and modern replies also include subcommands.
 */
export function parseRedisCommandCatalog(value: unknown): RedisCommandDocumentation[] {
  const docs = new Map<string, RedisCommandDocumentation>();
  const collect = (rawValue: unknown) => {
    if (isCommandInfo(rawValue)) {
      const rawName = rawValue[0];
      if (typeof rawName !== "string") return;
      const name = normalizeCommandName(rawName);
      if (name) {
        docs.set(name, {
          name,
          summary: undefined,
          since: undefined,
          group: undefined,
          arity: optionalNumber(rawValue[1]),
          keySpecs: legacyCommandKeySpecs(rawValue),
        });
      }
      // Redis 7+ appends subcommand command-info replies in slot 10.
      collect(rawValue[9]);
      return;
    }
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) collect(entry);
      return;
    }
    if (rawValue && typeof rawValue === "object") {
      // A cluster client can return a node-to-reply map through the bridge.
      if ("value" in rawValue) {
        collect(rawValue.value);
      } else {
        for (const entry of Object.values(rawValue)) collect(entry);
      }
    }
  };
  collect(value);
  return [...docs.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function mergeRedisCommandDocumentation(documentation: readonly RedisCommandDocumentation[], catalog: readonly RedisCommandDocumentation[]): RedisCommandDocumentation[] {
  const merged = new Map(catalog.map((command) => [command.name, command]));
  for (const command of documentation) {
    const catalogCommand = merged.get(command.name);
    merged.set(command.name, {
      ...catalogCommand,
      ...command,
      arity: command.arity ?? catalogCommand?.arity,
      keySpecs: command.keySpecs.length ? command.keySpecs : (catalogCommand?.keySpecs ?? []),
    });
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}
