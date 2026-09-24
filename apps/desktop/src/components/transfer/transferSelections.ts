import type { TransferObjectKind } from "@/lib/backend/api";

export interface TransferObjectSelectionPayload {
  objectType: TransferObjectKind;
  names: string[];
}

/**
 * Builds the `objects` payload of a transfer request from the tree
 * selection state. TABLE is handled by `tables`, and object types that
 * are currently disabled for this transfer (data-only mode, or kinds the
 * cross-family matrix does not allow) are dropped at the request boundary
 * even if stale selections are still present in the tree.
 */
export function buildTransferObjectSelections(selectedObjects: Partial<Record<TransferObjectKind, Set<string>>>, disabledGroups: TransferObjectKind[]): TransferObjectSelectionPayload[] {
  return (Object.keys(selectedObjects) as TransferObjectKind[])
    .filter((kind) => kind !== "TABLE" && !disabledGroups.includes(kind))
    .map((kind) => ({
      objectType: kind,
      names: [...(selectedObjects[kind] ?? [])],
    }));
}

/**
 * 「批量录入」可匹配的对象分组：kind 为对象类型，items 是该类型下的全部对象名。
 * 与 ObjectSelectionTree 的 ObjectTreeGroup 结构保持一致，只取匹配需要的字段。
 */
export interface BulkObjectNameGroup {
  kind: string;
  items: string[];
}

/** 「批量录入」的匹配结果 */
export interface BulkObjectNameMatchResult {
  /** 命中的对象：kind -> 名称列表（使用清单中的原始拼写，顺序与清单一致） */
  matched: Record<string, string[]>;
  /** 实际勾选的对象数量，即 matched 中所有名称之和 */
  matchedCount: number;
  /** 未匹配上的名称，保留用户输入的原始拼写，按输入顺序去重 */
  unmatchedNames: string[];
}

// 批量录入支持的分隔符：换行、逗号、分号、制表符
const BULK_NAME_SEPARATOR = /[\r\n,;\t]+/;

// 成对包裹标识符的引号，兼容 "orders" / 'orders' / `orders` / [orders]
const IDENTIFIER_WRAPPERS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["[", "]"],
];

function identifierWrapper(value: string): [string, string] | undefined {
  return IDENTIFIER_WRAPPERS.find(([open, close]) => value.length >= 2 && value.startsWith(open) && value.endsWith(close));
}

/**
 * 去掉标识符两侧成对的引号。只有首尾引号成对匹配时才剥离，
 * 避免把 a."b 这类不完整输入误处理成别的名称。
 */
function stripIdentifierQuotes(value: string): string {
  const trimmed = value.trim();
  const wrapper = identifierWrapper(trimmed);
  return wrapper ? trimmed.slice(1, -1).trim() : trimmed;
}

/**
 * 按引号与大小写无关的方式归一化名称，用于批量匹配的比较。
 */
function normalizeBulkName(value: string): string {
  return stripIdentifierQuotes(value).toLowerCase();
}

/**
 * 把「批量录入」文本切分为名称列表：支持换行、逗号、分号、制表符分隔，
 * 自动忽略空行与首尾空白。
 */
export function parseBulkObjectNames(text: string): string[] {
  return text
    .split(BULK_NAME_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface BulkNameToken {
  /** 用户输入的原始拼写（trim 后），用于未匹配提示 */
  raw: string;
  /** 归一化后的对象名；前缀 schema 不被接受时为 null（视为未匹配） */
  key: string | null;
}

/**
 * 解析单个输入项。支持 schema.table / catalog.schema.table 前缀：
 * 取最后一段作为对象名，前缀需与当前源库/schema 匹配（忽略大小写与引号）；
 * 若调用方没有提供任何可用的前缀（例如源 schema 为空），则放宽为按对象名匹配。
 * 整体被引号包裹时（如 "my.table"）视为字面名称，不再拆分前缀。
 */
function resolveBulkToken(token: string, qualifiers: readonly string[]): BulkNameToken {
  const raw = token.trim();
  if (!raw) return { raw, key: null };

  if (identifierWrapper(raw)) {
    const name = normalizeBulkName(raw);
    return { raw, key: name.length > 0 ? name : null };
  }

  if (raw.includes(".")) {
    const segments = raw.split(".");
    const namePart = segments.pop() ?? "";
    const accepted = qualifiers.length === 0 || segments.some((segment) => qualifierMatches(segment, qualifiers));
    if (!accepted) return { raw, key: null };
    const name = normalizeBulkName(namePart);
    return { raw, key: name.length > 0 ? name : null };
  }

  const name = normalizeBulkName(raw);
  return { raw, key: name.length > 0 ? name : null };
}

/**
 * 判断前缀段（db / schema / catalog）是否与当前源库信息一致。
 */
function qualifierMatches(segment: string, qualifiers: readonly string[]): boolean {
  const normalized = normalizeBulkName(segment);
  if (!normalized) return false;
  return qualifiers.some((qualifier) => normalizeBulkName(qualifier) === normalized);
}

/**
 * 把「批量录入」的文本匹配到对象清单上，得到需要勾选的对象。
 *
 * 匹配规则：
 * - 忽略大小写与成对引号；
 * - 支持 schema.table / catalog.schema.table 前缀，前缀与当前源库/schema 不一致的条目按未匹配处理；
 * - 同名对象只在清单中首个命中的分组里勾选（避免表与视图重名时被重复勾选）；
 * - 禁用（当前传输不支持）的对象类型不参与匹配。
 *
 * @param text 用户粘贴的原始文本
 * @param groups 完整的对象清单（不受当前搜索过滤影响）
 * @param disabledKinds 当前传输不支持、需要跳过的对象类型
 * @param qualifiers 可接受的对象名前缀（当前源的 catalog / 库 / schema）
 */
export function matchBulkObjectNames(text: string, groups: BulkObjectNameGroup[], disabledKinds: readonly string[] = [], qualifiers: readonly string[] = []): BulkObjectNameMatchResult {
  const tokens = parseBulkObjectNames(text).map((token) => resolveBulkToken(token, qualifiers));

  // 归一化名称 -> 输入中的首个原始拼写；匹配到即从 pending 中移除，用于去重与判定未匹配
  const pending = new Map<string, string>();
  for (const token of tokens) {
    if (token.key !== null && !pending.has(token.key)) pending.set(token.key, token.raw);
  }

  const matched: Record<string, string[]> = {};
  let matchedCount = 0;
  for (const group of groups) {
    if (disabledKinds.includes(group.kind)) continue;
    for (const item of group.items) {
      const key = normalizeBulkName(item);
      if (!pending.has(key)) continue;
      pending.delete(key);
      if (!matched[group.kind]) matched[group.kind] = [];
      matched[group.kind].push(item);
      matchedCount += 1;
    }
  }

  // 未匹配 = 前缀被拒绝的条目 + 清单中找不到的条目，按输入顺序去重
  const unmatchedNames: string[] = [];
  const seenUnmatched = new Set<string>();
  for (const token of tokens) {
    const isUnmatched = token.key === null || pending.has(token.key);
    if (!isUnmatched) continue;
    const dedupeKey = token.key ?? `#${token.raw.toLowerCase()}`;
    if (seenUnmatched.has(dedupeKey)) continue;
    seenUnmatched.add(dedupeKey);
    unmatchedNames.push(token.raw);
  }

  return { matched, matchedCount, unmatchedNames };
}
