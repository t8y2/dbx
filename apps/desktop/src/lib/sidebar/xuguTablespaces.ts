import type { TreeNode, XuguTablespaceInfo } from "@/types/database";

export type XuguStorageDetailEntry = {
  key: string;
  value: string;
  multiline?: boolean;
};

function detailValue(value: string | number | null | undefined): string {
  return value == null ? "" : String(value).trim();
}

function detailEntries(entries: XuguStorageDetailEntry[]): XuguStorageDetailEntry[] {
  return entries.filter((entry) => entry.value.length > 0);
}

/** Build the fields shown by the sidebar's Xugu tablespace detail popover. */
export function xuguTablespaceDetailRows(tablespace: XuguTablespaceInfo): XuguStorageDetailEntry[] {
  const total = tablespace.total_chunk_num;
  const free = tablespace.free_chunk_num;
  const used = total != null && free != null ? Math.max(total - free, 0) : null;
  const usage = total != null && total > 0 && used != null ? `${((used / total) * 100).toFixed(1)}%` : "";
  return detailEntries([
    { key: "name", value: detailValue(tablespace.space_name) },
    { key: "nodeId", value: detailValue(tablespace.node_id) },
    { key: "spaceId", value: detailValue(tablespace.space_id) },
    { key: "spaceType", value: detailValue(tablespace.space_type) },
    { key: "datafileCount", value: detailValue(tablespace.datafile_num) },
    { key: "totalChunks", value: detailValue(total) },
    { key: "freeChunks", value: detailValue(free) },
    { key: "usedChunks", value: detailValue(used) },
    { key: "usage", value: usage },
    { key: "mediaError", value: detailValue(tablespace.media_error) },
  ]);
}

/** Build the fields shown by the sidebar's Xugu datafile detail popover. */
export function xuguDatafileDetailRows(datafile: NonNullable<TreeNode["xuguDatafile"]>): XuguStorageDetailEntry[] {
  return detailEntries([
    { key: "name", value: xuguDatafileDisplayName(datafile.path, datafile.file_no) },
    { key: "path", value: detailValue(datafile.path), multiline: true },
    { key: "nodeId", value: detailValue(datafile.node_id) },
    { key: "spaceId", value: detailValue(datafile.space_id) },
    { key: "fileNo", value: detailValue(datafile.file_no) },
    { key: "currentSize", value: detailValue(datafile.curr_size) },
    { key: "maxSize", value: detailValue(datafile.max_size) },
    { key: "stepSize", value: detailValue(datafile.step_size) },
    { key: "reserved", value: detailValue(datafile.reserved1) },
  ]);
}

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
      xuguDatafile: file,
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
