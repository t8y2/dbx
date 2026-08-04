import { joinExportedDdls } from "@/lib/export/ddlExport";

export async function buildSidebarDdlTemplateSql<T>(targets: readonly T[], loadDdl: (target: T) => Promise<string>, formatDdl: (ddl: string, target: T) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  for (const target of targets) {
    parts.push(await formatDdl(await loadDdl(target), target));
  }
  return parts.length === 1 ? parts[0]! : joinExportedDdls(parts);
}
