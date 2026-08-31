import type { TreeNode, XuguTablespaceInfo } from "@/types/database";

export function xuguDatafileDisplayName(path: string, fileNo: number): string {
  const normalized = path.trim().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return basename || path.trim() || `file-${fileNo}`;
}

export function buildXuguTablespaceChildren(parent: Pick<TreeNode, "id" | "connectionId" | "database" | "children">, tablespaces: readonly XuguTablespaceInfo[]): TreeNode[] {
  const existing = new Map((parent.children ?? []).map((child) => [child.id, child] as const));
  return tablespaces.map((tablespace) => {
    const tablespaceId = `${parent.id}:tablespace:${tablespace.space_id}`;
    const previousTablespace = existing.get(tablespaceId);
    const filesGroupId = `${tablespaceId}:files`;
    const previousFilesGroup = previousTablespace?.children?.find((child) => child.id === filesGroupId);
    const fileNodes = tablespace.datafiles.map((file) => ({
      id: `${filesGroupId}:${file.file_no}:${file.path}`,
      label: xuguDatafileDisplayName(file.path, file.file_no),
      type: "datafile" as const,
      connectionId: parent.connectionId,
      database: parent.database,
      objectName: file.path,
      xuguDatafilePath: file.path,
      comment: file.path,
    }));
    const filesGroup: TreeNode = {
      id: filesGroupId,
      label: "tree.xuguDatafiles",
      type: "group-datafiles",
      connectionId: parent.connectionId,
      database: parent.database,
      objectCount: fileNodes.length,
      isExpanded: previousFilesGroup?.isExpanded ?? false,
      children: fileNodes,
    };
    return {
      id: tablespaceId,
      label: tablespace.space_name,
      type: "tablespace" as const,
      connectionId: parent.connectionId,
      database: parent.database,
      objectName: tablespace.space_name,
      xuguTablespace: tablespace,
      objectCount: tablespace.datafiles.length,
      isExpanded: previousTablespace?.isExpanded ?? false,
      children: [filesGroup],
    } satisfies TreeNode;
  });
}
