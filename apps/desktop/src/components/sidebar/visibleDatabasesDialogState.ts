import { MATCH_ALL_VISIBLE_DATABASE_PATTERN, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";

export type VisibleDatabaseSaveAction = { type: "none" } | { type: "clear" } | { type: "set"; databaseNames: string[] | undefined; patterns: string[] };

/**
 * 全匹配通配符由“是否显示系统库 + 是否全选”派生，不应该作为用户输入原样保留：
 * 否则用户取消“显示系统库”后，旧的 `%` 仍会让系统库继续显示。
 */
export function visibleDatabasePatternsWithoutMatchAll(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).filter((pattern) => pattern.trim() !== MATCH_ALL_VISIBLE_DATABASE_PATTERN);
}

export interface VisibleDatabaseSaveInput {
  /** 弹窗里当前勾选的库名。 */
  selection: ReadonlySet<string>;
  /** 连接上实际存在的全部库名（含系统库），用于规范化与落库。 */
  allNames: readonly string[];
  /** 未筛选时默认显示的库名（非系统库）。 */
  defaultVisibleNames: readonly string[];
  /** 已保存的 visible_databases。 */
  configured: readonly string[] | undefined;
  /** 已保存的 visible_database_patterns。 */
  configuredPatterns: readonly string[] | undefined;
  /** 本次要保存的通配符；连接弹窗不改通配符时与 configuredPatterns 相同。 */
  patterns: readonly string[];
}

/**
 * 显式名单是白名单语义：名单一旦落库，之后新建的库既不在名单内也不会自动出现。
 * 如果用户在弹窗里点的其实就是"全选"，把它存成"当时那份库名"的快照会让后来新增的库
 * 永久消失（用户会觉得"我明明没设置过筛选"）。因此勾选结果与默认可见集合完全一致、
 * 且没有通配符时，等价于不筛选，直接按"未筛选"保存。
 *
 * 打开"显示系统库"后全选会包含系统库，此时不能只按"未筛选"保存——未筛选的默认视图
 * 仍然隐藏系统库。也不能保存库名快照，否则新增库不会自动出现。改用全匹配通配符
 * `%` 表达"始终显示全部数据库"，系统库和之后新建的库都会保持可见。
 */
export function resolveVisibleDatabaseSaveAction(input: VisibleDatabaseSaveInput): VisibleDatabaseSaveAction {
  const allNames = [...input.allNames];
  const selectedNames = normalizeVisibleDatabaseSelection([...input.selection], allNames);
  const nextPatterns = normalizeVisibleDatabasePatterns(input.patterns);
  const configuredNames = input.configured ? normalizeVisibleDatabaseSelection([...input.configured], allNames) : undefined;
  const configuredPatterns = normalizeVisibleDatabasePatterns(input.configuredPatterns ?? []);

  const coversDefaultVisible = nextPatterns.length === 0 && sameSelection(selectedNames, input.defaultVisibleNames);
  const coversEveryName = sameSelection(selectedNames, allNames) && !sameSelection(allNames, input.defaultVisibleNames);

  let nextNames: string[] | undefined;
  let nextPatternValues: string[] | undefined;
  if (coversDefaultVisible) {
    nextNames = undefined;
    nextPatternValues = undefined;
  } else if (coversEveryName) {
    nextNames = undefined;
    nextPatternValues = [MATCH_ALL_VISIBLE_DATABASE_PATTERN];
  } else {
    // 通配符存在时不能丢掉名单：两者取并集，名单缺失会让未命中通配符的库一起消失。
    nextNames = selectedNames;
    nextPatternValues = nextPatterns.length > 0 ? nextPatterns : undefined;
  }

  if (sameOptionalSelection(nextNames, configuredNames) && sameOptionalSelection(nextPatternValues, configuredPatterns.length > 0 ? configuredPatterns : undefined)) {
    return { type: "none" };
  }
  if (nextNames === undefined && nextPatternValues === undefined) return { type: "clear" };
  return { type: "set", databaseNames: nextNames, patterns: nextPatternValues ?? [] };
}

function normalizeVisibleDatabasePatterns(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function sameOptionalSelection(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameSelection(left, right);
}

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((name) => rightSet.has(name));
}
