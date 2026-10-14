// Generate strings that match a user-supplied regular expression (the "regex"
// data generator, #12077). A small recursive-descent parser builds an AST from
// the subset of JS regex syntax that matters for data generation; candidates
// are then validated with the real RegExp engine as the source of truth.
// Unbounded quantifiers are capped so `a+` / `x{2,}` cannot explode, and any
// pattern we cannot satisfy (empty, invalid, or structurally unmatchable) is
// reported so callers can fall back gracefully.

type ClassPart = { ranges: Array<[number, number]>; complement: boolean };

type Node =
  | { t: "empty" }
  | { t: "lit"; s: string }
  | { t: "class"; parts: ClassPart[]; negated: boolean }
  | { t: "dot" }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; opts: Node[] }
  | { t: "rep"; node: Node; min: number; max: number | null }
  | { t: "anchor" }
  | { t: "group"; inner: Node; index: number; name?: string }
  | { t: "backref"; index?: number; name?: string };

export type RegexValueResult = { status: "ok"; value: string } | { status: "empty" | "invalid" | "nomatch" };

const MAX_ATTEMPTS = 8;
const MAX_REPEAT_EXTRA = 32;
const MAX_UNBOUNDED_EXTRA = 4;
// Absolute cap on a single counted repeat: larger min counts (e.g. `a{2000000000}`)
// pass `new RegExp` but would allocate strings past the engine's max length.
const MAX_REPEAT_COUNT = 4096;
const DOT_POOL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const DIGIT_RANGES: Array<[number, number]> = [[48, 57]];
const WORD_RANGES: Array<[number, number]> = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const SPACE_RANGES: Array<[number, number]> = [
  [9, 13],
  [32, 32],
];

interface Parser {
  s: string;
  i: number;
  captureCount: number;
}

function escapeClass(ch: string): ClassPart[] {
  switch (ch) {
    case "d":
      return [{ ranges: DIGIT_RANGES, complement: false }];
    case "D":
      return [{ ranges: DIGIT_RANGES, complement: true }];
    case "w":
      return [{ ranges: WORD_RANGES, complement: false }];
    case "W":
      return [{ ranges: WORD_RANGES, complement: true }];
    case "s":
      return [{ ranges: SPACE_RANGES, complement: false }];
    case "S":
      return [{ ranges: SPACE_RANGES, complement: true }];
    default:
      return [];
  }
}

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => cp >= a && cp <= b);
}

function classMatches(node: Extract<Node, { t: "class" }>, cp: number): boolean {
  let any = false;
  for (const part of node.parts) {
    const hit = inRanges(cp, part.ranges);
    if (part.complement ? !hit : hit) {
      any = true;
      break;
    }
  }
  return node.negated ? !any : any;
}

function safeChar(cp: number): string | null {
  if (cp >= 0xd800 && cp <= 0xdfff) return null;
  return String.fromCodePoint(cp);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickFromClass(node: Extract<Node, { t: "class" }>): string | null {
  if (!node.negated && node.parts.every((part) => !part.complement)) {
    const pool: string[] = [];
    for (const part of node.parts) {
      for (const [a, b] of part.ranges) {
        const span = b - a + 1;
        if (span > 128) {
          for (let k = 0; k < 4; k += 1) {
            const ch = safeChar(a + Math.floor(Math.random() * span));
            if (ch) pool.push(ch);
          }
        } else {
          for (let cp = a; cp <= b; cp += 1) {
            const ch = safeChar(cp);
            if (ch) pool.push(ch);
          }
        }
      }
    }
    return pool.length > 0 ? pick(pool) : null;
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const cp = 33 + Math.floor(Math.random() * 93);
    if (classMatches(node, cp)) return String.fromCodePoint(cp);
  }
  return null;
}

function parseEscape(p: Parser, asClass: boolean): Node | ClassPart[] | null {
  p.i += 1;
  const ch = p.s[p.i];
  if (ch === undefined) return null;
  p.i += 1;
  const classParts = escapeClass(ch);
  if (classParts.length > 0) {
    if (asClass) return classParts;
    return { t: "class", parts: classParts, negated: false };
  }
  if (ch === "b") {
    // Inside a class `[\b]` is the backspace character, not a word boundary.
    if (asClass) return [{ ranges: [[8, 8]], complement: false }];
    return { t: "anchor" };
  }
  if (ch === "B") return asClass ? null : { t: "anchor" };
  if (ch === "n") return asClass ? [{ ranges: [[10, 10]], complement: false }] : { t: "lit", s: "\n" };
  if (ch === "r") return asClass ? [{ ranges: [[13, 13]], complement: false }] : { t: "lit", s: "\r" };
  if (ch === "t") return asClass ? [{ ranges: [[9, 9]], complement: false }] : { t: "lit", s: "\t" };
  if (ch === "f") return asClass ? [{ ranges: [[12, 12]], complement: false }] : { t: "lit", s: "\f" };
  if (ch === "v") return asClass ? [{ ranges: [[11, 11]], complement: false }] : { t: "lit", s: "\v" };
  if (ch === "0") return asClass ? [{ ranges: [[0, 0]], complement: false }] : { t: "lit", s: "\0" };
  if (ch === "x") {
    const hex = p.s.slice(p.i, p.i + 2);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      p.i += 2;
      const cp = parseInt(hex, 16);
      return asClass ? [{ ranges: [[cp, cp]], complement: false }] : { t: "lit", s: String.fromCodePoint(cp) };
    }
    return asClass ? [{ ranges: [[120, 120]], complement: false }] : { t: "lit", s: "x" };
  }
  if (ch === "u") {
    const hex = p.s.slice(p.i, p.i + 4);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      p.i += 4;
      const cp = parseInt(hex, 16);
      return asClass ? [{ ranges: [[cp, cp]], complement: false }] : { t: "lit", s: String.fromCodePoint(cp) };
    }
    return asClass ? [{ ranges: [[117, 117]], complement: false }] : { t: "lit", s: "u" };
  }
  if (/[1-9]/.test(ch)) {
    let digits = ch;
    while (/[0-9]/.test(p.s[p.i] ?? "")) {
      digits += p.s[p.i];
      p.i += 1;
    }
    if (asClass) {
      const octal = parseInt(digits, 8);
      const cp = Number.isNaN(octal) ? digits.charCodeAt(0) : Math.min(255, octal);
      return [{ ranges: [[cp, cp]], complement: false }];
    }
    const index = parseInt(digits, 10);
    return { t: "backref", index };
  }
  if (ch === "k" && p.s[p.i] === "<") {
    const close = p.s.indexOf(">", p.i);
    if (close > 0) {
      const name = p.s.slice(p.i + 1, close);
      p.i = close + 1;
      if (asClass) return [{ ranges: [[107, 107]], complement: false }];
      return { t: "backref", name };
    }
  }
  const cp = ch.codePointAt(0) ?? 0;
  return asClass ? [{ ranges: [[cp, cp]], complement: false }] : { t: "lit", s: ch };
}

function parseClass(p: Parser): Node {
  p.i += 1;
  const node: Extract<Node, { t: "class" }> = { t: "class", parts: [], negated: false };
  if (p.s[p.i] === "^") {
    node.negated = true;
    p.i += 1;
  }
  let first = true;
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === "]" && !first) {
      p.i += 1;
      return node;
    }
    first = false;
    let startCp: number | null = null;
    if (c === "\\") {
      const escaped = parseEscape(p, true);
      if (escaped === null) throw new Error("invalid escape");
      if (Array.isArray(escaped)) node.parts.push(...escaped);
      else startCp = (escaped as { s: string }).s.codePointAt(0) ?? 0;
    } else if (c === "[") {
      const nested = parseClass(p);
      if (nested.t === "class") node.parts.push(...nested.parts.map((part) => ({ ranges: part.ranges, complement: nested.negated ? !part.complement : part.complement })));
      continue;
    } else {
      startCp = c.codePointAt(0) ?? 0;
      p.i += 1;
    }
    if (startCp === null) continue;
    if (p.s[p.i] === "-" && p.s[p.i + 1] !== undefined && p.s[p.i + 1] !== "]") {
      p.i += 1;
      let endCp: number;
      if (p.s[p.i] === "\\") {
        const escaped = parseEscape(p, true);
        if (escaped === null || Array.isArray(escaped)) throw new Error("invalid range end");
        endCp = (escaped as { s: string }).s.codePointAt(0) ?? 0;
      } else {
        endCp = p.s.codePointAt(p.i) ?? 0;
        p.i += 1;
      }
      if (endCp < startCp) [startCp, endCp] = [endCp, startCp];
      node.parts.push({ ranges: [[startCp, endCp]], complement: false });
    } else {
      node.parts.push({ ranges: [[startCp, startCp]], complement: false });
    }
  }
  throw new Error("unterminated class");
}

function parseAtom(p: Parser): Node {
  const c = p.s[p.i];
  if (c === "(") {
    p.i += 1;
    let name: string | undefined;
    let capturing = true;
    if (p.s.startsWith("?:", p.i)) {
      capturing = false;
      p.i += 2;
    } else if (p.s.startsWith("?=", p.i) || p.s.startsWith("?!", p.i)) {
      capturing = false;
      p.i += 2;
      parseAlt(p);
      if (p.s[p.i] !== ")") throw new Error("expected )");
      p.i += 1;
      return { t: "anchor" };
    } else if (p.s.startsWith("?<=", p.i) || p.s.startsWith("?<!", p.i)) {
      capturing = false;
      p.i += 4;
      parseAlt(p);
      if (p.s[p.i] !== ")") throw new Error("expected )");
      p.i += 1;
      return { t: "anchor" };
    } else if (p.s.startsWith("?<", p.i)) {
      const close = p.s.indexOf(">", p.i + 2);
      if (close < 0) throw new Error("unterminated group name");
      name = p.s.slice(p.i + 2, close);
      p.i = close + 1;
    }
    let index = 0;
    if (capturing) {
      index = p.captureCount + 1;
      p.captureCount = index;
    }
    const inner = parseAlt(p);
    if (p.s[p.i] !== ")") throw new Error("expected )");
    p.i += 1;
    if (!capturing) return inner;
    return { t: "group", inner, index, name };
  }
  if (c === "[") return parseClass(p);
  if (c === ".") {
    p.i += 1;
    return { t: "dot" };
  }
  if (c === "^" || c === "$") {
    p.i += 1;
    return { t: "anchor" };
  }
  if (c === "\\") {
    const escaped = parseEscape(p, false);
    if (escaped === null || Array.isArray(escaped)) throw new Error("invalid escape");
    return escaped;
  }
  const cp = p.s.codePointAt(p.i) ?? 0;
  p.i += cp > 0xffff ? 2 : 1;
  return { t: "lit", s: String.fromCodePoint(cp) };
}

function parseQuantifier(p: Parser, atom: Node): Node {
  let min = 0;
  let max: number | null = null;
  const c = p.s[p.i];
  if (c === "*") {
    min = 0;
    max = null;
    p.i += 1;
  } else if (c === "+") {
    min = 1;
    max = null;
    p.i += 1;
  } else if (c === "?") {
    min = 0;
    max = 1;
    p.i += 1;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*)?)?\}/.exec(p.s.slice(p.i));
    if (!m) return atom;
    min = parseInt(m[1], 10);
    if (m[2] === undefined) max = min;
    else if (!m[3]) max = null;
    else max = Math.max(min, parseInt(m[3], 10));
    p.i += m[0].length;
  } else {
    return atom;
  }
  if (p.s[p.i] === "?") p.i += 1;
  return { t: "rep", node: atom, min, max };
}

function parseConcat(p: Parser): Node {
  const items: Node[] = [];
  while (p.i < p.s.length) {
    const c = p.s[p.i];
    if (c === "|" || c === ")") break;
    items.push(parseQuantifier(p, parseAtom(p)));
  }
  return items.length === 0 ? { t: "empty" } : items.length === 1 ? items[0] : { t: "cat", items };
}

function parseAlt(p: Parser): Node {
  const opts: Node[] = [parseConcat(p)];
  while (p.s[p.i] === "|") {
    p.i += 1;
    opts.push(parseConcat(p));
  }
  return opts.length === 1 ? opts[0] : { t: "alt", opts };
}

function parsePattern(src: string): Node {
  const p: Parser = { s: src, i: 0, captureCount: 0 };
  const node = parseAlt(p);
  if (p.i < p.s.length) throw new Error("unexpected )");
  return node;
}

interface Ctx {
  captures: Array<string | null>;
  names: Map<string, string>;
}

function gen(node: Node, ctx: Ctx): string | null {
  switch (node.t) {
    case "empty":
    case "anchor":
      return "";
    case "lit":
      return node.s;
    case "dot":
      return pick(Array.from(DOT_POOL));
    case "class":
      return pickFromClass(node);
    case "cat": {
      let out = "";
      for (const item of node.items) {
        const part = gen(item, ctx);
        if (part === null) return null;
        out += part;
      }
      return out;
    }
    case "alt":
      return gen(pick(node.opts), ctx);
    case "group": {
      const inner = gen(node.inner, ctx);
      if (inner === null) return null;
      ctx.captures[node.index - 1] = inner;
      if (node.name) ctx.names.set(node.name, inner);
      return inner;
    }
    case "backref": {
      if (node.name !== undefined) return ctx.names.get(node.name) ?? null;
      if (node.index !== undefined) return ctx.captures[node.index - 1] ?? null;
      return null;
    }
    case "rep": {
      if (node.min > MAX_REPEAT_COUNT) return null;
      const bound = node.max === null ? node.min + MAX_UNBOUNDED_EXTRA : Math.min(node.max, node.min + MAX_REPEAT_EXTRA);
      const count = node.min + Math.floor(Math.random() * (bound - node.min + 1));
      let out = "";
      for (let i = 0; i < count; i += 1) {
        const part = gen(node.node, ctx);
        if (part === null) return null;
        out += part;
      }
      return out;
    }
  }
}

interface Compiled {
  re: RegExp;
  ast: Node;
}

const cache = new Map<string, Compiled | null>();

function compile(pattern: string, raw: boolean): Compiled | null {
  const key = `${raw ? "r" : "a"}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let compiled: Compiled | null = null;
  try {
    const re = new RegExp(raw ? pattern : `^(?:${pattern})$`);
    compiled = { re, ast: parsePattern(pattern) };
  } catch {
    compiled = null;
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

export function generateRegexValue(pattern: string | undefined, rawPattern?: boolean): RegexValueResult {
  const source = pattern ?? "";
  if (source.trim() === "") return { status: "empty" };
  const compiled = compile(source, rawPattern === true);
  if (!compiled) return { status: "invalid" };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const ctx: Ctx = { captures: [], names: new Map() };
    try {
      const value = gen(compiled.ast, ctx);
      if (value !== null && compiled.re.test(value)) return { status: "ok", value };
    } catch {
      // Generation is best-effort; any runtime failure (e.g. string-length
      // limits) degrades to the nomatch fallback instead of aborting the table.
    }
  }
  return { status: "nomatch" };
}
