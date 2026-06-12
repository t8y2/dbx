import type { TreeNodeType } from "@/types/database";

const leafTypes: Set<TreeNodeType> = new Set([
  "column",
  "index",
  "fkey",
  "trigger",
  "procedure",
  "function",
  "package",
  "package-body",
  "object-browser",
  "redis-db",
  "mongo-collection",
  "elasticsearch-index",
  "kafka-topic",
  "kafka-consumer-group",
  "kafka-schema-subject",
  "user-admin",
  "saved-sql-file",
]);

const fullWidthLabelTypes: Set<TreeNodeType> = new Set(["table", "view", "mongo-collection", "elasticsearch-index", "kafka-topic", "kafka-consumer-group", "kafka-schema-subject"]);

const emptyContainerTypes: Set<TreeNodeType> = new Set(["saved-sql-root", "saved-sql-folder"]);

const kafkaSectionRootTypes: Set<TreeNodeType> = new Set(["kafka-brokers-root", "kafka-topics-root", "kafka-groups-root", "kafka-schemas-root", "kafka-acls-root"]);

export function isKafkaSectionRoot(type: TreeNodeType): boolean {
  return kafkaSectionRootTypes.has(type);
}

export function isKafkaTabSectionRoot(type: TreeNodeType): boolean {
  return type === "kafka-brokers-root" || type === "kafka-acls-root";
}

export function treeItemPaddingLeft(depth: number): string {
  return `${depth * 16 + 8}px`;
}

export function usesFullWidthTreeLabel(type: TreeNodeType, allowHorizontalScroll: boolean): boolean {
  return allowHorizontalScroll && fullWidthLabelTypes.has(type);
}

export function canTreeNodeExpand(type: TreeNodeType): boolean {
  return !leafTypes.has(type);
}

export function canTreeNodeShowExpander({ type, childCount }: { type: TreeNodeType; childCount?: number }): boolean {
  if (!canTreeNodeExpand(type)) return false;
  if (isKafkaTabSectionRoot(type)) return false;
  if (childCount === 0 && emptyContainerTypes.has(type)) return false;
  return true;
}
