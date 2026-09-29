import { normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";

export type VisibleDatabaseSaveAction = { type: "none" } | { type: "clear" } | { type: "set"; databaseNames: string[]; patterns: string[] };

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
 */
export function resolveVisibleDatabaseSaveAction(input: VisibleDatabaseSaveInput): VisibleDatabaseSaveAction {
  const allNames = [...input.allNames];
  const selectedNames = normalizeVisibleDatabaseSelection([...input.selection], allNames);
  const nextPatterns = normalizeVisibleDatabasePatterns(input.patterns);
  const configuredNames = input.configured ? normalizeVisibleDatabaseSelection([...input.configured], allNames) : undefined;
  const configuredPatterns = normalizeVisibleDatabasePatterns(input.configuredPatterns ?? []);

  const coversDefaultVisible = nextPatterns.length === 0 && sameSelection(selectedNames, input.defaultVisibleNames);
  const nextNames = coversDefaultVisible ? undefined : selectedNames;
  // 通配符存在时不能丢掉名单：两者取并集，名单缺失会让未命中通配符的库一起消失。
  const nextPatternValues = nextNames === undefined || nextPatterns.length === 0 ? undefined : nextPatterns;

  if (sameOptionalSelection(nextNames, configuredNames) && sameOptionalSelection(nextPatternValues, configuredPatterns.length > 0 ? configuredPatterns : undefined)) {
    return { type: "none" };
  }
  if (nextNames === undefined) return { type: "clear" };
  return { type: "set", databaseNames: nextNames, patterns: nextPatterns };
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
