export interface TableFilterOptions {
  caseSensitive?: boolean;
}

/**
 * 编译单个过滤 token（可能是 /pattern/flags 正则，也可能是普通文本子串）
 * 返回一个判断函数 (name: string) => boolean
 */
/**
 * 尝试将字符串解析为 /pattern/flags 正则
 * 如果成功返回已配置的 RegExp，否则返回 null
 */
function tryParseRegex(text: string, defaultCaseSensitive: boolean): RegExp | null {
  if (!text.startsWith("/")) return null;
  const lastSlash = text.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const pattern = text.slice(1, lastSlash);
  const rawFlags = text.slice(lastSlash + 1);

  if (!/^[dgimsuvy]*$/.test(rawFlags)) return null;

  let cleanFlags = rawFlags.replace(/[gy]/g, "");
  if (!cleanFlags.includes("i") && !defaultCaseSensitive) {
    cleanFlags += "i";
  }

  try {
    return new RegExp(pattern, cleanFlags);
  } catch {
    return null;
  }
}

/**
 * 编译单个过滤 token（可能是 /pattern/flags 正则，也可能是普通文本子串）
 * 返回一个判断函数 (name: string) => boolean
 */
function compileMatcher(token: string, defaultCaseSensitive: boolean): (name: string) => boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return () => false;
  }

  // 检查是否是 /pattern/flags 形式的正则
  const regex = tryParseRegex(trimmed, defaultCaseSensitive);
  if (regex) {
    return (name: string) => regex.test(name);
  }

  // 普通文本匹配（包含匹配，若带斜杠等非法正则自动降级为此处）
  if (defaultCaseSensitive) {
    return (name: string) => name.includes(trimmed);
  }
  const lower = trimmed.toLowerCase();
  return (name: string) => name.toLowerCase().includes(lower);
}

/**
 * 智能切分查询 tokens：支持逗号分隔，但保留正则表达式内部的逗号
 */
function splitFilterQuery(raw: string): string[] {
  // 如果没有逗号，直接作为单个 token
  if (!raw.includes(",") && !raw.includes("，")) {
    return [raw];
  }

  // 如果首尾形式上像一个正则 /.../flags，但中间包含了逗号，
  // 我们需要判断它是一个包含逗号的单体正则（例如 `/(users|orders)/`），
  // 还是逗号分隔的多个 token（例如 `/^user/, orders, /_bak$/`）。
  // 如果在第一个逗号之前存在未转义的闭合斜杠 `/`，或者切分后的每一项能有效匹配独立规则，
  // 则应该作为逗号分隔处理。
  const firstComma = Math.min(raw.indexOf(",") === -1 ? Infinity : raw.indexOf(","), raw.indexOf("，") === -1 ? Infinity : raw.indexOf("，"));
  const firstSlashAfterStart = raw.indexOf("/", 1);

  // 如果在逗号之前就已经出现了斜杠闭合（如 `/^user/, orders`），说明整体绝不是单个正则
  if (firstSlashAfterStart > 0 && firstSlashAfterStart < firstComma) {
    return raw
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // 尝试看整体是否是合法正则
  const wholeRegex = tryParseRegex(raw, false);
  if (wholeRegex) {
    return [raw];
  }

  // 否则按照中英文逗号切分
  return raw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 判断单张表是否匹配过滤查询
 * 满足逗号分隔中的任一项或正则即视为匹配（OR 逻辑）
 */
export function matchTableFilter(tableName: string, query: string, options?: TableFilterOptions): boolean {
  const raw = query.trim();
  if (!raw) return true;

  const terms = splitFilterQuery(raw);
  if (terms.length === 0) return true;

  const matchers = terms.map((term) => compileMatcher(term, options?.caseSensitive ?? false));
  return matchers.some((matcher) => matcher(tableName));
}

/**
 * 过滤表名列表
 * 导出 filterTableNames 与 filterExportTables 别名以兼顾不同命名习惯
 */
export function filterTableNames(tables: readonly string[], query: string, options?: TableFilterOptions): string[] {
  const raw = query.trim();
  if (!raw) return [...tables];

  const terms = splitFilterQuery(raw);
  if (terms.length === 0) return [...tables];

  const matchers = terms.map((term) => compileMatcher(term, options?.caseSensitive ?? false));
  return tables.filter((name) => matchers.some((m) => m(name)));
}

/**
 * 别名，兼容 architect 设计方案中的方法命名
 */
export const filterExportTables = filterTableNames;
