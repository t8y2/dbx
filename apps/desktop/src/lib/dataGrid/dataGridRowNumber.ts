/**
 * 行号栏取值。
 *
 * `displayIndex` 是当前视图里的压缩序号：一旦应用筛选（Ctrl+F 过滤模式、列头筛选、
 * 行状态筛选），被隐藏的行后面的行号会整体前移，无法再对应回完整结果里的位置。
 * `sourceIndex` 是筛选前的原始下标，一直保留在行数据里，因此 `source` 模式直接用它，
 * 让筛选前后同一个行号始终指向同一条数据。分页模式下原始下标是页内下标，
 * 仍需叠加页偏移才能得到完整结果中的位置。
 */
export interface DataGridRowNumberInput {
  displayIndex: number;
  sourceIndex?: number;
  isDraft?: boolean;
  /** true = 显示原始行号（sourceIndex），false = 显示当前视图序号（displayIndex） */
  sourceRowNumbers: boolean;
  /** 已加载行之前的行数：分页页码偏移；无限滚动 / 单页时为 0 */
  pageOffset: number;
}

export function resolveDataGridRowNumberLabel(input: DataGridRowNumberInput): string {
  // 待保存的草稿行没有落库位置，保持原有的 "*" 占位
  if (input.isDraft) return "*";
  const index = input.sourceRowNumbers && input.sourceIndex !== undefined ? input.sourceIndex : input.displayIndex;
  return String(index + 1 + input.pageOffset);
}
