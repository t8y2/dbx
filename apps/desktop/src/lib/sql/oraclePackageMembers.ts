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
  isFunction: boolean;
  /** `PROCEDURE` / `FUNCTION` 关键字的字符偏移，直接可用于编辑器定位。 */
  offset: number;
  /** 1-based 行号。 */
  line: number;
  /** 形参名（大写，按声明顺序）；无参或空参数表为 `[]`。 */
  parameters: string[];
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

/**
 * 从子程序头的参数表起点开始读出形参名，并判定这是实现还是声明。
 *
 * `start` 指向名字之后的第一个 token。参数表内的 token depth 为 1，嵌套括号
 * （默认值里的函数调用等）depth 更深，所以只认 depth === 1 的逗号与名字；
 * 函数的 `RETURN <type>` 落在参数表之后、`IS`/`AS`/`;` 之前，原样跳过即可。
 */
function readMemberShape(tokens: SqlSemanticToken[], start: number): { parameters: string[]; implemented: boolean } {
  const parameters: string[] = [];
  let index = start;
  if (tokens[index]?.text === "(") {
    index += 1;
    let expectName = true;
    for (; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.depth === 0 && token.text === ")") {
        index += 1;
        break;
      }
      if (token.depth !== 1) continue;
      if (token.text === ",") {
        expectName = true;
        continue;
      }
      if (!expectName || !tokenIsIdentifier(token)) continue;
      parameters.push(unquoteSqlSemanticIdentifier(token).toUpperCase());
      expectName = false;
    }
  }
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.depth !== 0) continue;
    if (token.kind === "word" && (token.normalized === "is" || token.normalized === "as")) return { parameters, implemented: true };
    if (token.text === ";") return { parameters, implemented: false };
  }
  return { parameters, implemented: false };
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
  let line = 1;
  let lineEnd = source.indexOf("\n");
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const token = tokens[index]!;
    const name = tokens[index + 1];
    const next = tokens[index + 2]!;
    if (token.kind !== "word" || token.depth !== 0 || (token.normalized !== "procedure" && token.normalized !== "function")) continue;
    if (!tokenIsIdentifier(name) || name.closed === false || tokens[index - 1]?.text === ".") continue;
    const isFunction = token.normalized === "function";
    if (next.text !== "(" && (isFunction ? next.normalized !== "return" : ![";", "is", "as"].includes(next.normalized))) continue;
    const offset = token.span.start;
    while (lineEnd !== -1 && lineEnd < offset) {
      line += 1;
      lineEnd = source.indexOf("\n", lineEnd + 1);
    }
    entries.push({ name: unquoteSqlSemanticIdentifier(name), isFunction, offset, line, ...readMemberShape(tokens, index + 2) });
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
  return readMemberShape(
    tokenizeSqlSemantic(`(${text})`, "oracle").filter((token) => token.kind !== "comment"),
    0,
  ).parameters;
}

/**
 * 在包源码里定位一个成员。找不到返回 null（调用方据此放弃定位，而不是把光标
 * 丢到一个猜出来的位置上——跳错比不跳更难发现）。
 *
 * 消歧顺序：名字（先精确、后大小写不敏感）→ 过程/函数 → 实现优先于前置声明 →
 * 形参名序列全等 → 形参个数相同 → 第一个候选。
 */
export function findOraclePackageMember(source: string, query: OraclePackageMemberQuery): OraclePackageMemberEntry | null {
  const wanted = unquoteIdentifierText(query.name);
  if (!wanted) return null;
  const all = oraclePackageMemberEntries(source);
  const exactName = all.filter((entry) => entry.name === wanted);
  const named = exactName.length ? exactName : all.filter((entry) => entry.name.toUpperCase() === wanted.toUpperCase());
  if (!named.length) return null;
  const typed = query.kind ? named.filter((entry) => entry.isFunction === (query.kind === "function")) : [];
  const candidates = typed.length ? typed : named;
  const implemented = candidates.filter((entry) => entry.implemented);
  const pool = implemented.length ? implemented : candidates;
  if (pool.length === 1) return pool[0]!;
  const parameters = oracleRoutineSignatureParameters(query.signature || "");
  const exact = pool.find((entry) => entry.parameters.length === parameters.length && entry.parameters.every((value, index) => value === parameters[index]));
  return exact ?? pool.find((entry) => entry.parameters.length === parameters.length) ?? pool[0]!;
}
