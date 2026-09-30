/**
 * 从源代码里复制出来的「字符串拼接 SQL」还原工具。
 *
 * 使用场景：用户从 Java / JS / TS / Python / Go / C# / Kotlin / PHP 等源码里复制
 * 形如
 *
 *     "SELECT * " +
 *     "FROM users \n " +
 *     "WHERE id = 1"
 *
 * 的拼接 SQL，粘贴进 SQL 编辑器时希望自动去掉字符串引号、`+` 连接符与 `\n`
 * 转义，还原成可直接执行的普通 SQL。
 *
 * 设计原则（宁可「不转换」，也绝不改坏用户内容）：
 * 1. 只有当整段文本完全由「字符串字面量 + 合法连接符（空白/+/.）」构成时才尝试还原；
 * 2. 还原结果必须命中 SQL 语句起始关键字，否则视为误判、原样返回；
 * 3. 任何解析失败、超长输入都原样返回，且函数不抛异常。
 */

/** 超过该长度直接放弃解析，避免对超大文本做逐字符扫描 */
export const SQL_SOURCE_PASTE_MAX_LENGTH = 256 * 1024;

/** 还原结果：changed 为 false 时 sql 与输入完全一致，调用方应保持原样粘贴 */
export interface SqlSourcePasteResult {
  /** 还原后的 SQL；未识别时等于输入原文 */
  sql: string;
  /** 是否发生了还原 */
  changed: boolean;
}

/**
 * 还原结果必须命中 SQL 语句起始关键字，用于排除「误把普通源码字符串当 SQL」的情况。
 * 允许前置空白、行注释与块注释。
 */
const SQL_STATEMENT_START_RE =
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|RENAME|CALL|EXEC|EXECUTE|EXPLAIN|SHOW|DESC|DESCRIBE|SET|USE|GRANT|REVOKE|VACUUM|ANALYZE|PRAGMA|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|DECLARE|LOCK|UNLOCK)\b/i;

/**
 * 允许出现在第一个字面量之前的「赋值前缀」，例如：
 * `sql = `、`String sql = `、`final String SQL = `、`query := `、`const q = `。
 * 末尾允许一个左括号（覆盖 `sql = ("..." "..." )` 这种写法）。
 * 前缀里不允许出现引号，因此不会吞掉字面量本身。
 * 捕获组 1 为 `=` 之前的前缀文本、捕获组 2 为赋值操作符，用于区分
 * 声明性赋值与裸标识符赋值（见 DECLARATION_KEYWORD_RE）。
 */
const ASSIGNMENT_PREFIX_RE = /^([A-Za-z0-9_$.[\]<>,:\s]*?)(:?=)\s*\(?\s*/;

/**
 * 判定赋值前缀是否「声明性」：出现声明关键字（Java/Kotlin/JS/TS/Go 的
 * 类型或 var/const/let/final/val 等）。`:=`（Go 短声明）也视为声明。
 * 裸标识符赋值（如 `status = 'DELETE'`）不算声明：单个字面量不足以证明
 * 这是「从源码复制的 SQL」，只有出现两个字面量以上的拼接时才还原，
 * 避免把条件片段里的单个 SQL 关键字字符串误改写。
 */
const DECLARATION_KEYWORD_RE = /(?:^|[^A-Za-z0-9_$])(?:string|const|let|var|final|val|def|dim|static)(?:[^A-Za-z0-9_$]|$)/i;

/** 结尾允许出现的收尾字符：空白、行继续符、闭合括号与语句结束分号 */
const TRAILING_TAIL_RE = /^[\s\\]*\)*[\s\\]*;?[\s\\]*$/;

/** 可出现在引号前、用于修饰字符串语义的字母（Python 的 r/b/f/u、C# 的 @/$ 等） */
const LITERAL_PREFIX_CHARS = new Set(["r", "R", "b", "B", "u", "U", "f", "F", "@", "$"]);

/** 两个字面量之间允许的连接符：Java/JS/Go/Python 的 `+`，PHP/Ruby 的 `.` */
const CONNECTOR_CHARS = new Set(["+", "."]);

interface StringLiteralToken {
  /** 已按源码语义还原转义后的内容 */
  content: string;
  /** 字面量结束后的位置（即下一个待解析字符的下标） */
  end: number;
}

/**
 * 跳过空白与行继续符（`\` + 换行），返回新的位置。
 */
function skipBlank(source: string, from: number): number {
  let pos = from;
  while (pos < source.length) {
    const ch = source[pos];
    if (/\s/.test(ch)) {
      pos += 1;
      continue;
    }
    // 行继续符：反斜杠后面紧跟换行，视为空白
    if (ch === "\\" && pos + 1 < source.length && /[\r\n]/.test(source[pos + 1])) {
      pos += 2;
      if (source[pos - 1] === "\r" && source[pos] === "\n") pos += 1;
      continue;
    }
    break;
  }
  return pos;
}

/**
 * 反解「转义字符串」里的转义序列（Java/JS/Python 等非 raw 字面量通用规则）。
 * 未知转义保留反斜杠本身（JS/Python 语义），避免改写 LIKE 模式等内容。
 */
function unescapeLiteralContent(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) {
      out += "\\";
      continue;
    }
    index += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "\n":
        // 行继续符：反斜杠 + 换行不产生任何输出
        break;
      case "u": {
        const hex = raw.slice(index + 1, index + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          out += "u";
        }
        break;
      }
      case "x": {
        const hex = raw.slice(index + 1, index + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 2;
        } else {
          out += "x";
        }
        break;
      }
      case "'":
      case '"':
      case "`":
      case "\\":
      case "/":
        // 引号/反斜杠/斜杠的恒等转义：去掉反斜杠本身
        out += next;
        break;
      default:
        // 未知转义：JS/Python 语义是保留反斜杠（如 LIKE '100\%'），
        // Java 里未知转义本就是编译错误，保留反斜杠更贴近用户原文
        out += "\\" + next;
        break;
    }
  }
  return out;
}

/** C# 逐字字符串（@"..."）里用 `""` 表示一个双引号，反斜杠不转义 */
function unescapeVerbatimContent(raw: string): string {
  return raw.replace(/""/g, '"');
}

/**
 * 判断引号前是否存在语义前缀（如 `r"` / `f"` / `@$"`），返回前缀起始下标。
 * 只有紧贴引号、且长度不超过 3、且前面不是标识符字符时才算前缀，
 * 避免把 `name"x"` 这类内容误判。
 */
function literalPrefixStart(source: string, quotePos: number): number {
  let start = quotePos;
  while (start > 0 && quotePos - start < 3 && LITERAL_PREFIX_CHARS.has(source[start - 1])) {
    const before = start - 2;
    if (before >= 0 && /[\w$]/.test(source[before])) break;
    start -= 1;
  }
  return start;
}

/**
 * 判断 cursor 处是否是「前缀字母 + 引号」的写法（`r"` / `f"` / `b'` / `@$"` 等），
 * 是则返回引号所在下标；否则返回 null。
 */
function quoteAfterLiteralPrefix(source: string, cursor: number): number | null {
  let pos = cursor;
  while (pos < source.length && pos - cursor < 3 && LITERAL_PREFIX_CHARS.has(source[pos])) pos += 1;
  if (pos === cursor || pos >= source.length) return null;
  return source[pos] === '"' || source[pos] === "'" || source[pos] === "`" ? pos : null;
}

/**
 * 从 cursor 处读取一个字面量，兼容前面带有修饰字母的写法（`r"..."` / `@"..."`）。
 */
function readLiteralAtCursor(source: string, cursor: number): StringLiteralToken | null {
  const directQuote = source[cursor];
  const quotePos = directQuote === '"' || directQuote === "'" || directQuote === "`" ? cursor : quoteAfterLiteralPrefix(source, cursor);
  if (quotePos === null) return null;
  return readStringLiteral(source, quotePos);
}

/**
 * 从 quotePos 处读取一个字符串字面量。支持：
 * - 单引号 / 双引号 / 反引号（JS 模板字符串，`${}` 原样保留）；
 * - 三引号文本块（Java、Python 的 `"""` / `'''`）；
 * - raw 前缀（Python `r""`）与 C# 逐字字符串（`@"..."`）。
 * 未闭合或不是字面量时返回 null。
 */
function readStringLiteral(source: string, quotePos: number): StringLiteralToken | null {
  const quote = source[quotePos];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;

  const prefixStart = literalPrefixStart(source, quotePos);
  const prefix = source.slice(prefixStart, quotePos);
  const isRaw = /[rR]/.test(prefix) || prefix.includes("@");
  const isVerbatim = prefix.includes("@");
  const isTriple = source.startsWith(quote.repeat(3), quotePos);
  const openLength = isTriple ? 3 : 1;

  let pos = quotePos + openLength;
  let rawContent = "";
  while (pos < source.length) {
    const ch = source[pos];
    if (!isRaw && ch === "\\") {
      // 转义序列整体交给反解函数处理，这里只负责不要把它当成结束引号
      rawContent += ch;
      if (pos + 1 < source.length) rawContent += source[pos + 1];
      pos += 2;
      continue;
    }
    if (isRaw && ch === "\\" && !isVerbatim) {
      // Python raw 字符串：反斜杠不转义，但保留「反斜杠 + 引号」以免提前截断
      rawContent += ch;
      if (pos + 1 < source.length) rawContent += source[pos + 1];
      pos += 2;
      continue;
    }
    if (isVerbatim && ch === quote && source[pos + 1] === quote) {
      // C# 逐字字符串里 `""` 表示一个双引号，不能当作结束引号
      rawContent += quote + quote;
      pos += 2;
      continue;
    }
    if (isTriple ? source.startsWith(quote.repeat(3), pos) : ch === quote) {
      const end = pos + openLength;
      const content = isVerbatim ? unescapeVerbatimContent(rawContent) : isRaw ? rawContent : unescapeLiteralContent(rawContent);
      return { content, end };
    }
    rawContent += ch;
    pos += 1;
  }
  return null;
}

/**
 * 判断两个字面量之间（between 为其原文）是否为合法拼接：
 * - 隐式拼接（Python/Kotlin）：中间只有空白，且确实有空白分隔；
 * - 显式拼接：中间为空白 + `+` 或 `.` + 空白。
 * 其他情况（如 `||`、`,`、函数参数）一律判定为「不是源码拼接」，放弃还原。
 */
function isLiteralSeparator(between: string, sawConnector: boolean): boolean {
  const compact = between.replace(/\\\s/g, "");
  if (sawConnector) return /^\s*[+.]\s*$/.test(compact);
  return compact.length > 0 && /^\s+$/.test(compact);
}

/**
 * 解析整段「源码拼接 SQL」，成功时返回按顺序拼接好的字面量内容列表。
 * 只要出现无法解释的内容就返回 null（调用方据此保持原文粘贴）。
 */
function parseSourceSqlLiterals(source: string): string[] | null {
  let pos = 0;
  const prefixMatch = source.match(ASSIGNMENT_PREFIX_RE);
  let bareAssignment = false;
  if (prefixMatch) {
    // 裸标识符赋值（无声明关键字且不是 :=）：只有多字面量拼接才算源码 SQL
    bareAssignment = prefixMatch[2] !== ":=" && !DECLARATION_KEYWORD_RE.test(prefixMatch[1]);
    pos = prefixMatch[0].length;
  }
  pos = skipBlank(source, pos);

  const first = readLiteralAtCursor(source, pos);
  if (!first) return null;
  const fragments = [first.content];
  pos = first.end;

  for (;;) {
    const gapStart = pos;
    let cursor = skipBlank(source, pos);
    let sawConnector = false;
    if (cursor < source.length && CONNECTOR_CHARS.has(source[cursor])) {
      sawConnector = true;
      cursor = skipBlank(source, cursor + 1);
    }

    const next = readLiteralAtCursor(source, cursor);
    if (!next) {
      // 没有更多字面量：只允许「空白 + 可选右括号/分号」收尾
      if (!TRAILING_TAIL_RE.test(source.slice(gapStart))) return null;
      if (bareAssignment && fragments.length < 2) return null;
      return fragments;
    }
    if (!isLiteralSeparator(source.slice(gapStart, cursor), sawConnector)) return null;
    fragments.push(next.content);
    pos = next.end;
  }
}

/**
 * 把从源码复制的拼接 SQL 还原为普通 SQL。
 *
 * @param source 剪贴板里的原文
 * @param maxLength 解析长度上限，超过则原样返回
 * @returns 还原结果；changed 为 false 表示未识别，调用方应原样粘贴
 */
export function restoreSqlFromSourcePaste(source: string, maxLength: number = SQL_SOURCE_PASTE_MAX_LENGTH): SqlSourcePasteResult {
  const unchanged: SqlSourcePasteResult = { sql: source, changed: false };
  if (typeof source !== "string" || source.length === 0 || source.length > maxLength) return unchanged;

  const trimmed = source.trim();
  if (!trimmed) return unchanged;

  const fragments = parseSourceSqlLiterals(trimmed);
  if (!fragments || fragments.length === 0) return unchanged;

  const joined = fragments.join("").trim();
  // 拼接结果为空或与原文完全相同（例如本来就不是字面量拼接）时不改写
  if (!joined || joined === trimmed) return unchanged;
  // 还原结果必须像一条 SQL 语句，否则视为误判
  if (!SQL_STATEMENT_START_RE.test(joined)) return unchanged;

  return { sql: joined, changed: true };
}
