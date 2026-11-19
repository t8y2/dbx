import { diagramIdentityKey, type DiagramTableIdentity } from "./diagramMetadataLoader";

export const FOCUSED_TABLE_COLOR = "#9F2B68";

export function isFocusedTable(table: { name: string; schema?: string }, roots: DiagramTableIdentity[]): boolean {
  return roots.some((root) => diagramIdentityKey(root) === diagramIdentityKey(table));
}
