import { computed, ref } from "vue";
import type { ConnectionConfig } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";

export interface QuickOpenItem {
  id: string;
  type: "connection" | "database" | "schema" | "table" | "view" | "materialized_view" | "procedure" | "function" | "sequence" | "package" | "package-body";
  label: string;
  description?: string;
  connectionId: string;
  database?: string;
  schema?: string;
  objectName?: string; // For non-table objects (views, procedures, functions, sequences, packages)
  tableName?: string; // Kept for backward compatibility
  connectionName?: string;
  searchText: string; // Lowercase text for searching
}

/**
 * Fuzzy match function that checks if query matches text
 * Returns the matched indices for highlighting
 */
function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (!lowerQuery) return { score: Infinity, indices: [] };
  if (lowerText.includes(lowerQuery)) {
    // Exact substring match gets highest score
    const startIdx = lowerText.indexOf(lowerQuery);
    return {
      score: 1,
      indices: Array.from({ length: lowerQuery.length }, (_, i) => startIdx + i),
    };
  }

  // Fuzzy match: find all characters in order
  let queryIdx = 0;
  const indices: number[] = [];
  let score = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      indices.push(i);
      // Score based on proximity (consecutive chars score better)
      score += lastMatchIdx === i - 1 ? 2 : 1;
      lastMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx === lowerQuery.length) {
    return { score: score / lowerQuery.length, indices };
  }

  return null;
}

interface MatchedItem extends QuickOpenItem {
  matchScore: number;
  matchIndices: number[];
}

export function useQuickOpen() {
  const connectionStore = useConnectionStore();
  const searchQuery = ref("");
  const selectedIndex = ref(0);

  const allItems = computed((): QuickOpenItem[] => {
    const items: QuickOpenItem[] = [];
    const connections = connectionStore.connections;
    const treeNodes = connectionStore.treeNodes;

    // Add connections
    for (const conn of connections) {
      items.push({
        id: `conn-${conn.id}`,
        type: "connection",
        label: conn.name,
        connectionId: conn.id,
        connectionName: conn.name,
        searchText: `${conn.name}`,
      });
    }

    // Add databases and tables from tree nodes
    // Filter tree nodes by connection
    for (const conn of connections) {
      // Connections may live under sidebar groups, so locate their tree recursively.
      const connectionTreeNode = findConnectionTreeNode(treeNodes, conn.id);
      const connectionTreeNodes = connectionTreeNode?.children || treeNodes.filter((node) => node.connectionId === conn.id);
      if (connectionTreeNodes.length === 0) continue;

      // Process tree nodes to extract databases and tables
      processDatabaseTreeNodes(connectionTreeNodes, conn, items);
    }

    return items;
  });

  function processDatabaseTreeNodes(nodes: any[], conn: ConnectionConfig, items: QuickOpenItem[]): void {
    for (const node of nodes) {
      // Skip certain node types
      if (node.type === "group" || node.type === "linked-server-root") {
        if (node.children) {
          processDatabaseTreeNodes(node.children, conn, items);
        }
        continue;
      }

      // Database nodes
      if (node.type === "database" && node.database) {
        items.push({
          id: `db-${conn.id}-${node.database}`,
          type: "database",
          label: node.label || node.database,
          description: conn.name,
          connectionId: conn.id,
          database: node.database,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database}`,
        });
      }

      // Schema nodes are navigable results and also contain database objects.
      if (node.type === "schema" && node.database && node.schema) {
        items.push({
          id: `schema-${conn.id}-${node.database}-${node.schema}`,
          type: "schema",
          label: node.label || node.schema,
          description: `${conn.name} / ${node.database}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema}`,
        });
        if (node.children) processDatabaseTreeNodes(node.children, conn, items);
        continue;
      }

      // Table nodes
      if (node.type === "table" && node.database && node.label) {
        items.push({
          id: `table-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "table",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          tableName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // View nodes
      if (node.type === "view" && node.database && node.label) {
        items.push({
          id: `view-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "view",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Materialized view nodes
      if (node.type === "materialized_view" && node.database && node.label) {
        items.push({
          id: `mview-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "materialized_view",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Procedure nodes
      if (node.type === "procedure" && node.database && node.label) {
        items.push({
          id: `proc-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "procedure",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Function nodes
      if (node.type === "function" && node.database && node.label) {
        items.push({
          id: `func-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "function",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Sequence nodes
      if (node.type === "sequence" && node.database && node.label) {
        items.push({
          id: `seq-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "sequence",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Package nodes
      if (node.type === "package" && node.database && node.label) {
        items.push({
          id: `pkg-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "package",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Package-body nodes
      if (node.type === "package-body" && node.database && node.label) {
        items.push({
          id: `pkgbody-${conn.id}-${node.database}-${node.schema || ""}-${node.label}`,
          type: "package-body",
          label: node.label,
          description: `${conn.name} / ${node.database}${node.schema ? " / " + node.schema : ""}`,
          connectionId: conn.id,
          database: node.database,
          schema: node.schema,
          objectName: node.label,
          connectionName: conn.name,
          searchText: `${conn.name} ${node.database} ${node.schema || ""} ${node.label}`,
        });
      }

      // Process children recursively
      if (node.children) {
        processDatabaseTreeNodes(node.children, conn, items);
      }
    }
  }

  function findConnectionTreeNode(nodes: any[], connectionId: string): any | undefined {
    for (const node of nodes) {
      if (node.type === "connection" && node.connectionId === connectionId) return node;
      if (node.children) {
        const match = findConnectionTreeNode(node.children, connectionId);
        if (match) return match;
      }
    }
    return undefined;
  }

  const filteredItems = computed((): MatchedItem[] => {
    if (!searchQuery.value.trim()) {
      return allItems.value.map((item) => ({
        ...item,
        matchScore: Infinity,
        matchIndices: [],
      }));
    }

    const matched: MatchedItem[] = [];

    for (const item of allItems.value) {
      const result = fuzzyMatch(searchQuery.value, item.searchText);
      if (result) {
        matched.push({
          ...item,
          matchScore: result.score,
          matchIndices: result.indices,
        });
      }
    }

    // Sort by score and type (connections > databases > tables > other objects for equal scores)
    matched.sort((a, b) => {
      if (a.matchScore !== b.matchScore) {
        return a.matchScore - b.matchScore; // Lower scores (better matches) come first
      }

      const typeOrder = {
        connection: 0,
        database: 1,
        schema: 2,
        table: 3,
        view: 4,
        materialized_view: 5,
        procedure: 6,
        function: 7,
        sequence: 8,
        package: 9,
        "package-body": 10,
      };
      return typeOrder[a.type] - typeOrder[b.type];
    });

    return matched;
  });

  const selectedItem = computed((): MatchedItem | null => {
    if (selectedIndex.value < 0 || selectedIndex.value >= filteredItems.value.length) {
      return null;
    }
    return filteredItems.value[selectedIndex.value];
  });

  function selectNext(): void {
    if (selectedIndex.value < filteredItems.value.length - 1) {
      selectedIndex.value++;
    }
  }

  function selectPrevious(): void {
    if (selectedIndex.value > 0) {
      selectedIndex.value--;
    }
  }

  function resetSelection(): void {
    selectedIndex.value = 0;
  }

  function setQuery(query: string): void {
    searchQuery.value = query;
    resetSelection();
  }

  return {
    searchQuery,
    filteredItems,
    selectedIndex,
    selectedItem,
    selectNext,
    selectPrevious,
    resetSelection,
    setQuery,
  };
}
