import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { isWindows } from "@/lib/backend/platform";
import { resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import type { ExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import type { ConnectionConfig } from "@/types/database";

/**
 * 项目上下文为权威数据源时的外部 SQL 文件执行目标。
 * 相比 ExternalSqlFileTarget 多出 projectId 与 defaultSchema。
 */
export interface ProjectFileTarget extends ExternalSqlFileTarget {
  projectId?: string;
  schema?: string;
}

export interface ProjectLike {
  id: string;
  rootPath: string;
  connectionId: string | null;
  defaultSchema: string | null;
}

export interface ResolveProjectFileTargetOptions {
  connectionExists: (connectionId: string) => boolean;
  getConnection: (connectionId: string) => ConnectionConfig | undefined;
  projects: ProjectLike[];
  activeConnectionId: string | null | undefined;
  firstConnectionId?: string | undefined;
}

/** 按文件绝对路径找所属项目（最长根前缀匹配，Windows 大小写不敏感）。 */
export function findProjectForFilePath(projects: ProjectLike[], filePath: string): ProjectLike | null {
  const normalized = filePath.replace(/\//g, "\\");
  const cmp = isWindows() ? normalized.toLowerCase() : normalized;
  let best: ProjectLike | null = null;
  for (const project of projects) {
    let root = project.rootPath.replace(/\//g, "\\");
    if (isWindows()) root = root.toLowerCase();
    if (!root.endsWith("\\")) root += "\\";
    if (cmp.startsWith(root) && (!best || project.rootPath.length > best.rootPath.length)) best = project;
  }
  return best;
}

/**
 * 项目上下文权威解析外部 SQL 文件的执行目标：
 * 1. 文件属于「已绑定有效连接」的项目 → 绑定 connectionId + database +
 *    defaultSchema（优先级高于 localStorage 每文件历史 target）；
 * 2. 否则回退 legacy：每文件历史 target → active → first 连接。
 * 无项目归属的文件行为与旧 resolveExternalSqlFileTarget 一致。
 */
export function resolveProjectFileTarget(path: string, options: ResolveProjectFileTargetOptions): ProjectFileTarget {
  const project = findProjectForFilePath(options.projects, path);
  const base = { projectId: project?.id };

  if (project?.connectionId && options.connectionExists(project.connectionId)) {
    const connection = options.getConnection(project.connectionId);
    const database = connection ? resolveDefaultDatabase(connection, []) : "";
    return {
      connectionId: project.connectionId,
      database,
      schema: project.defaultSchema ?? undefined,
      ...base,
    };
  }

  const fallback: ExternalSqlFileTarget = {
    connectionId: options.activeConnectionId || options.firstConnectionId || "",
    database: "",
  };
  const target = resolveExternalSqlFileTarget(path, options.connectionExists, fallback);
  let database = target.database;
  if (target.connectionId && !database) {
    const connection = options.getConnection(target.connectionId);
    database = connection ? resolveDefaultDatabase(connection, []) : "";
  }
  return { connectionId: target.connectionId, database, catalog: target.catalog, ...base };
}
