import type { DeleteConnectionTabHandlingMode } from "@/stores/settingsStore";

/**
 * 删除连接时对已打开页签的保留范围。
 *
 * 与「断开连接」不同，删除后连接配置已从磁盘移除、无法再重连，因此被保留下来的
 * SQL 页签只是草稿工作区；它们会记录原连接名，等新建同名连接时再重新绑定。
 *
 * - `none`：关闭全部页签
 * - `sql`：保留全部 SQL 页签（清空结果），其余关闭
 * - `pinned-sql`：只保留固定的 SQL 页签（清空结果），其余关闭
 * - `all`：不关闭任何页签，保留 SQL 文本与当前结果，只回滚事务
 */
export type DeletedConnectionTabKeepMode = "none" | "sql" | "pinned-sql" | "all";

export function deletedConnectionTabKeepMode(mode: DeleteConnectionTabHandlingMode): DeletedConnectionTabKeepMode {
  if (mode === "keep-sql-tabs") return "sql";
  if (mode === "keep-pinned-sql-tabs") return "pinned-sql";
  if (mode === "keep-all-tabs") return "all";
  return "none";
}
