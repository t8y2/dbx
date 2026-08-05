import { joinExportedDdls } from "@/lib/export/ddlExport";

interface SidebarDdlExecutionTarget {
  connectionId: string;
  database: string;
  catalog?: string;
}

export function sidebarDdlTargetsForExecutionContext<T extends SidebarDdlExecutionTarget>(activeTarget: SidebarDdlExecutionTarget, targets: readonly T[]): T[] {
  return targets.filter((target) => target.connectionId === activeTarget.connectionId && target.database === activeTarget.database && (target.catalog ?? "") === (activeTarget.catalog ?? ""));
}

export async function buildSidebarDdlTemplateSql<T>(targets: readonly T[], loadDdl: (target: T) => Promise<string>, formatDdl: (ddl: string, target: T) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  for (const target of targets) {
    parts.push(await formatDdl(await loadDdl(target), target));
  }
  return parts.length === 1 ? parts[0]! : joinExportedDdls(parts);
}
