import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import { tokenizeSqlSemantic, tokenIsIdentifier, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";

/**
 * Oracle 包源码里的一个子程序头。
 *
 * 同一份文本既可能是包头（`PROCEDURE X(...);` 声明）也可能是包体
 * （`PROCEDURE X(...) IS ... END X;` 实现），两者的头部形状在 `implemented` 上区分。
 */
export interface OraclePackageMemberEntry {
  /** 去引号后的子程序名，大小写保持源码原样。 */
  name: string;
  /** Identifier as stored in the Oracle data dictionary. */
  databaseName: string;
  isFunction: boolean;
  /** `PROCEDURE` / `FUNCTION` 关键字的字符偏移，直接可用于编辑器定位。 */
  offset: number;
  /** 1-based 行号。 */
  line: number;
  /** 形参名（大写，按声明顺序）；无参或空参数表为 `[]`。 */
  parameters: string[];
  databaseParameterNames: string[];
  /** Datatypes without parameter modes, defaults, or precision modifiers. */
  parameterTypes: string[];
  /** 头部后跟 `IS`/`AS`（包体实现）为 true；后跟 `;`（包头声明）为 false。 */
  implemented: boolean;
}

/** 要定位的成员身份。`signature` 用于重载消歧，取数据字典给出的形参文本。 */
export interface OraclePackageMemberQuery {
  name: string;
  kind?: "procedure" | "function";
  signature?: string;
}

function unquoteIdentifierText(raw: string): string {
  const text = raw.trim();
  return text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replaceAll('""', '"') : text;
}

function databaseIdentifier(token: SqlSemanticToken): string {
  const name = unquoteSqlSemanticIdentifier(token);
  return token.kind === "quoted_identifier" ? name : name.toUpperCase();
}

const PARAMETER_MODIFIERS = new Set(["in", "out", "nocopy"]);
const EXTERNAL_BODY_PREFIXES = new Set(["language c", "language java", "language javascript", "external name", "external library", "mle module"]);

function readParameter(tokens: SqlSemanticToken[], start: number, end: number): { name: string; type: string } | undefined {
  const name = tokens[start];
  if (!tokenIsIdentifier(name)) return undefined;
  let index = start + 1;
  while (index < end && (PARAMETER_MODIFIERS.has(tokens[index]!.normalized) || tokens[index]!.text === "/")) index += 1;
  const type: string[] = [];
  for (; index < end; index += 1) {
    const token = tokens[index]!;
    if (token.depth !== 1 || token.text === "(" || token.text === ")") continue;
    if (token.text === ":" || token.normalized === "default") break;
    type.push(token.kind === "quoted_identifier" ? token.text : token.text.toUpperCase());
  }
  return { name: databaseIdentifier(name), type: type.join(" ").replace(/ \. /g, ".") };
}

function readParameterList(tokens: SqlSemanticToken[], start: number) {
  const databaseParameterNames: string[] = [];
  const parameterTypes: string[] = [];
  let index = start;
  if (tokens[index]?.text === "(") {
    index += 1;
    let parameterStart = index;
    for (; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const closesList = token.depth === 0 && token.text === ")";
      if (!closesList && (token.depth !== 1 || token.text !== ",")) continue;
      if (parameterStart < index) {
        const parameter = readParameter(tokens, parameterStart, index);
        if (parameter) {
          databaseParameterNames.push(parameter.name);
          parameterTypes.push(parameter.type);
        }
      }
      parameterStart = index + 1;
      if (closesList) {
        index += 1;
        break;
      }
    }
  }
  return { parameters: databaseParameterNames.map((name) => name.toUpperCase()), databaseParameterNames, parameterTypes, index };
}

function readMemberShape(tokens: SqlSemanticToken[], start: number) {
  const { parameters, databaseParameterNames, parameterTypes, index: afterParameters } = readParameterList(tokens, start);
  let index = afterParameters;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.depth !== 0) continue;
    if (token.kind === "word" && (token.normalized === "is" || token.normalized === "as")) return { parameters, databaseParameterNames, parameterTypes, implemented: true, index };
    if (token.text === ";") break;
  }
  return { parameters, databaseParameterNames, parameterTypes, implemented: false, index };
}

/**
 * 最近一次解析结果。一个大包体要完整 tokenize 一遍，真机实测（SCOTT.SALES_PKG，
 * 11459 行 / 849 KB）约 180 ms，而同一份源码会被解析两次：成员大纲侧栏一次、
 * 打开时的光标定位一次。两边都走这里，第二次就是一次字符串比较。
 *
 * 只留一格：源码 tab 一次只看一个对象，留更多只是占着内存。返回的数组是只读的，
 * 调用方拿到的是同一个引用。
 */
let lastParsedPackage: { source: string; entries: readonly OraclePackageMemberEntry[] } | undefined;

/** 包头/包体源码里全部顶层子程序头，按出现顺序。 */
export function oraclePackageMemberEntries(source: string): readonly OraclePackageMemberEntry[] {
  if (lastParsedPackage?.source === source) return lastParsedPackage.entries;
  const tokens = tokenizeSqlSemantic(source, "oracle").filter((token) => token.kind !== "comment");
  const entries: OraclePackageMemberEntry[] = [];
  // Subprograms open a declarative scope before their first BEGIN. A nested
  // subprogram can end while its parent is still in that declarative scope.
  const scopes: ("declarations" | "block" | "case")[] = [];
  let line = 1;
  let lineEnd = source.indexOf("\n");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "word" || token.depth !== 0) continue;
    const word = token.normalized;
    if (word === "begin") {
      if (scopes[scopes.length - 1] === "declarations") scopes.pop();
      scopes.push("block");
    } else if (word === "case") {
      scopes.push("case");
    } else if (word === "end") {
      const suffix = tokens[index + 1]?.normalized;
      // IF and LOOP always have named terminators. They do not own a BEGIN.
      if (suffix === "if" || suffix === "loop") {
        index += 1;
      } else if (scopes.length > 0) {
        scopes.pop();
        if (suffix === "case") index += 1;
      } else {
        break;
      }
    } else if (word === "procedure" || word === "function") {
      const name = tokens[index + 1];
      const next = tokens[index + 2];
      if (!next || !tokenIsIdentifier(name) || name.closed === false || tokens[index - 1]?.text === ".") continue;
      const isFunction = word === "function";
      if (next.text !== "(" && (isFunction ? next.normalized !== "return" : ![";", "is", "as"].includes(next.normalized))) continue;
      const { index: headerEnd, ...shape } = readMemberShape(tokens, index + 2);
      if (scopes.length === 0) {
        const offset = token.span.start;
        while (lineEnd !== -1 && lineEnd < offset) {
          line += 1;
          lineEnd = source.indexOf("\n", lineEnd + 1);
        }
        entries.push({ name: unquoteSqlSemanticIdentifier(name), databaseName: databaseIdentifier(name), isFunction, offset, line, ...shape });
      }
      // External call specifications end at their semicolon and have no BEGIN.
      const bodyPrefix = `${tokens[headerEnd + 1]?.normalized} ${tokens[headerEnd + 2]?.normalized}`;
      if (shape.implemented && !EXTERNAL_BODY_PREFIXES.has(bodyPrefix)) scopes.push("declarations");
      index = headerEnd;
    }
  }
  lastParsedPackage = { source, entries };
  return entries;
}

/**
 * 数据字典给出的形参文本（`VO IN PKG.T, IRET OUT VARCHAR2`）里的形参名序列。
 * 直接复用参数表解析：补一对括号就是同一种形状。
 */
export function oracleRoutineSignatureParameters(signature: string): string[] {
  const text = signature.trim();
  if (!text) return [];
  return readSignature(text).parameters;
}

function readSignature(signature: string) {
  return readParameterList(
    tokenizeSqlSemantic(`(${signature})`, "oracle").filter((token) => token.kind !== "comment"),
    0,
  );
}

function matchingTypes(candidate: string[], wanted: string[], allowUnqualified: boolean): boolean {
  return candidate.every((type, index) => {
    const other = wanted[index]!;
    return !!type && !!other && (type === other || (allowUnqualified && (type.endsWith(`.${other}`) || other.endsWith(`.${type}`))));
  });
}

/** Prefer implementations and use datatypes to distinguish otherwise matching signatures. */
export function findOraclePackageMember(source: string, query: OraclePackageMemberQuery): OraclePackageMemberEntry | null {
  const wanted = unquoteIdentifierText(query.name);
  if (!wanted) return null;
  const all = oraclePackageMemberEntries(source).filter((entry) => !query.kind || entry.isFunction === (query.kind === "function"));
  const exactName = all.filter((entry) => entry.name === wanted);
  const named = exactName.length ? exactName : all.filter((entry) => entry.name.toUpperCase() === wanted.toUpperCase());
  const signature = query.signature === undefined ? undefined : readSignature(query.signature);
  const candidates = signature ? named.filter((entry) => entry.parameters.length === signature.parameters.length && entry.parameters.every((name, index) => name === signature.parameters[index])) : named;
  if (!candidates.length) return null;
  const implemented = candidates.filter((entry) => entry.implemented);
  const pool = implemented.length ? implemented : candidates;
  if (pool.length === 1) return pool[0]!;
  if (!signature) return null;
  const exact = pool.filter((entry) => matchingTypes(entry.parameterTypes, signature.parameterTypes, false));
  if (exact.length) return exact.length === 1 ? exact[0]! : null;
  const unqualified = pool.filter((entry) => matchingTypes(entry.parameterTypes, signature.parameterTypes, true));
  return unqualified.length === 1 ? unqualified[0]! : null;
}
