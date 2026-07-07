import type { Component } from "vue";
import { Archive, Braces, Columns3, Database, Eye, FileCode, FolderClosed, FolderOpen, Key, Link, ListTree, Network, Package, Plus, ScrollText, Server, Table, TableProperties, UsersRound, Zap } from "@lucide/vue";
import type { ColumnInfo, TreeNode } from "@/types/database";

export type TreeNodeIconInfo = {
  icon: Component;
  colorClass: string;
};

export function getTreeNodeIconInfo(node: TreeNode): TreeNodeIconInfo | null {
  switch (node.type) {
    case "schema":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-amber-500" };
    case "connection":
    case "database":
    case "mongo-db":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "vector-database":
      return { icon: Database, colorClass: "text-cyan-500" };
    case "linked-server-root":
      return { icon: Network, colorClass: "text-blue-500" };
    case "linked-server":
      return { icon: Server, colorClass: "text-blue-400" };
    case "linked-server-catalog":
    case "linked-server-schema":
    case "mq-tenant":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "doris-catalog":
      return { icon: FolderOpen, colorClass: "text-emerald-500" };
    case "nacos-namespace":
    case "etcd-root":
      return { icon: FolderOpen, colorClass: "text-sky-500" };
    case "zookeeper-root":
      return { icon: Database, colorClass: "text-blue-500" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "materialized_view":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "column":
      return { icon: Columns3, colorClass: (node.meta as ColumnInfo | undefined)?.is_primary_key ? "text-orange-400" : "text-muted-foreground" };
    case "group-columns":
      return { icon: ListTree, colorClass: "text-green-400" };
    case "group-indexes":
    case "index":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-fkeys":
      return { icon: Link, colorClass: "text-blue-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "group-triggers":
      return { icon: Zap, colorClass: "text-orange-400" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "object-browser":
      return { icon: TableProperties, colorClass: "text-primary" };
    case "user-admin":
      return { icon: UsersRound, colorClass: "text-primary" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "mongo-gridfs":
    case "mongo-buckets":
      return { icon: Archive, colorClass: "text-cyan-500" };
    case "mongo-bucket":
      return { icon: Archive, colorClass: "text-cyan-400" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    case "vector-collection":
      return { icon: TableProperties, colorClass: "text-cyan-400" };
    case "elasticsearch-index":
      return { icon: Table, colorClass: "text-emerald-400" };
    case "procedure":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "function":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "sequence":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "package":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "package-body":
      return { icon: FileCode, colorClass: "text-cyan-400" };
    case "group-tables":
      return { icon: Table, colorClass: "text-green-500" };
    case "group-views":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "group-materialized-views":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "group-procedures":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "group-functions":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "group-sequences":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "group-packages":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "group-partitions":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-green-400" };
    case "group-extensions":
      return { icon: Package, colorClass: "text-violet-500" };
    case "extension":
      return { icon: Package, colorClass: "text-violet-400" };
    case "load-more":
      return { icon: Plus, colorClass: "text-primary" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}
