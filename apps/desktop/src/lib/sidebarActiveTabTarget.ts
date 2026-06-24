import { SIDEBAR_TREE_ROW_HEIGHT, type FlatTreeNode } from "@/composables/useFlatTree";
import type { QueryTab, TreeNode } from "@/types/database";

export type ActiveTabSidebarTarget =
  | {
      type: "table";
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
    }
  | {
      type: "mongo-collection";
      connectionId: string;
      database: string;
      collectionName: string;
    }
  | {
      type: "vector-collection";
      connectionId: string;
      collectionName: string;
    }
  | {
      type: "etcd-root";
      connectionId: string;
    }
  | {
      type: "zookeeper-root";
      connectionId: string;
    }
  | {
      type: "mq-tenant";
      connectionId: string;
      tenant: string;
    }
  | {
      type: "nacos-namespace";
      connectionId: string;
      namespace: string;
    }
  | {
      type: "query-context";
      connectionId: string;
      database: string;
      schema?: string;
    }
  | {
      type: "saved-sql-file";
      savedSqlId: string;
    };

export function activeTabSidebarTarget(tab: QueryTab | undefined | null): ActiveTabSidebarTarget | null {
  if (!tab) return null;

  if (tab.mode === "data") {
    const tableName = tab.tableMeta?.tableName || tab.title;
    if (!tableName) return null;
    return {
      type: "table",
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.tableMeta?.schema ?? tab.schema,
      tableName,
    };
  }

  if (tab.mode === "mongo") {
    const collectionName = tab.sql || tab.title.split(".").pop() || tab.title;
    if (!collectionName) return null;
    return {
      type: "mongo-collection",
      connectionId: tab.connectionId,
      database: tab.database,
      collectionName,
    };
  }

  if (tab.mode === "vector") {
    const collectionName = tab.sql || tab.title;
    if (!collectionName) return null;
    return {
      type: "vector-collection",
      connectionId: tab.connectionId,
      collectionName,
    };
  }

  if (tab.mode === "etcd") {
    return { type: "etcd-root", connectionId: tab.connectionId };
  }

  if (tab.mode === "zookeeper") {
    return { type: "zookeeper-root", connectionId: tab.connectionId };
  }

  if (tab.mode === "mq" && tab.mqTenant) {
    return { type: "mq-tenant", connectionId: tab.connectionId, tenant: tab.mqTenant };
  }

  if (tab.mode === "nacos") {
    return { type: "nacos-namespace", connectionId: tab.connectionId, namespace: tab.nacosNamespace || "" };
  }

  if (tab.savedSqlId) {
    return { type: "saved-sql-file", savedSqlId: tab.savedSqlId };
  }

  if (tab.mode === "query") {
    if (!tab.connectionId || !tab.database) return null;
    return {
      type: "query-context",
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
    };
  }

  return null;
}

function schemaMatches(node: TreeNode, schema: string | undefined): boolean {
  if (!schema) return true;
  return (node.schema || "") === schema;
}

export function matchesTarget(node: TreeNode, target: ActiveTabSidebarTarget): boolean {
  if (target.type === "mongo-collection") {
    if (node.type === "elasticsearch-index") {
      return node.connectionId === target.connectionId && node.label === target.collectionName;
    }
    return node.type === "mongo-collection" && node.connectionId === target.connectionId && node.database === target.database && node.label === target.collectionName;
  }

  if (target.type === "vector-collection") {
    return node.type === "vector-collection" && node.connectionId === target.connectionId && node.label === target.collectionName;
  }

  if (target.type === "query-context") {
    if (target.schema) {
      return node.type === "schema" && node.connectionId === target.connectionId && node.database === target.database && node.label === target.schema;
    }
    return node.type === "database" && node.connectionId === target.connectionId && node.label === target.database;
  }

  if (target.type === "etcd-root") {
    return node.type === "etcd-root" && node.connectionId === target.connectionId;
  }

  if (target.type === "zookeeper-root") {
    return node.type === "zookeeper-root" && node.connectionId === target.connectionId;
  }

  if (target.type === "mq-tenant") {
    return node.type === "mq-tenant" && node.connectionId === target.connectionId && (node.mqTenant || node.label) === target.tenant;
  }

  if (target.type === "nacos-namespace") {
    return node.type === "nacos-namespace" && node.connectionId === target.connectionId && (node.nacosNamespace || "") === target.namespace;
  }

  if (target.type === "saved-sql-file") {
    return node.type === "saved-sql-file" && node.savedSqlId === target.savedSqlId;
  }

  return (node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId === target.connectionId && node.database === target.database && schemaMatches(node, target.schema) && node.label === target.tableName;
}

export function findSidebarNodeForActiveTab(tab: QueryTab | undefined | null, flatNodes: readonly FlatTreeNode[]): FlatTreeNode | null {
  const target = activeTabSidebarTarget(tab);
  if (!target) return null;
  return findSidebarNodeForTarget(target, flatNodes);
}

export function findSidebarNodeForTarget(target: ActiveTabSidebarTarget, flatNodes: readonly FlatTreeNode[]): FlatTreeNode | null {
  return flatNodes.find((item) => matchesTarget(item.node, target)) ?? null;
}

export function shouldScrollActiveSidebarSelection(options: { activeTabId: string | null | undefined; previousActiveTabId: string | null | undefined; autoSelectEnabled: boolean; previousAutoSelectEnabled: boolean | undefined }): boolean {
  if (!options.autoSelectEnabled) return false;
  return options.activeTabId !== options.previousActiveTabId || (options.autoSelectEnabled && options.previousAutoSelectEnabled === false);
}

export function scrollTopForSidebarNode(options: { index: number; currentScrollTop: number; viewportHeight: number; rowHeight?: number }): number {
  const rowHeight = options.rowHeight ?? SIDEBAR_TREE_ROW_HEIGHT;
  if (options.index < 0 || options.viewportHeight <= 0) return options.currentScrollTop;

  const rowTop = options.index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const viewportTop = options.currentScrollTop;
  const viewportBottom = options.currentScrollTop + options.viewportHeight;

  if (rowTop < viewportTop) return rowTop;
  if (rowBottom > viewportBottom) return Math.max(0, rowBottom - options.viewportHeight);
  return options.currentScrollTop;
}

export function findNodePathForActiveTab(tab: QueryTab | undefined | null, treeNodes: readonly TreeNode[]): TreeNode[] | null {
  const target = activeTabSidebarTarget(tab);
  if (!target) return null;
  return findNodePathForTarget(target, treeNodes);
}

export function findNodePathForTarget(target: ActiveTabSidebarTarget, treeNodes: readonly TreeNode[]): TreeNode[] | null {
  return findPath(treeNodes, (node) => matchesTarget(node, target));
}

function findPath(nodes: readonly TreeNode[], predicate: (node: TreeNode) => boolean, path: TreeNode[] = []): TreeNode[] | null {
  for (const node of nodes) {
    const currentPath = [...path, node];
    if (predicate(node)) return currentPath;
    if (node.children) {
      const result = findPath(node.children, predicate, currentPath);
      if (result) return result;
    }
  }
  return null;
}
