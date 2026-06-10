import type { TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarLabelMatcher, type SidebarLabelMatcher } from "@/lib/sidebarSearch";

const preserveMatchedSubtreeTypes = new Set(["database", "schema", "table", "view"]);

const normalizedLabelCache = new WeakMap<TreeNode, { label: string; normalized: string }>();

function bestMatch(matchLabel: SidebarLabelMatcher, label: string, comment?: string | null) {
  const lm = matchLabel(label);
  if (!comment) return lm;
  const cm = matchLabel(comment.toLowerCase());
  if (lm && cm) return lm.score >= cm.score ? lm : cm;
  return lm ?? cm;
}

function normalizedLabel(node: TreeNode): string {
  const cached = normalizedLabelCache.get(node);
  if (cached?.label === node.label) return cached.normalized;

  const normalized = node.label.toLowerCase();
  normalizedLabelCache.set(node, { label: node.label, normalized });
  return normalized;
}

export function filterSidebarTree(nodes: TreeNode[], query: string, collapsedIds: ReadonlySet<string>, searchableNodeTypes?: ReadonlySet<TreeNodeType>): TreeNode[] {
  return filterSidebarTreeWithMatcher(nodes, createSidebarLabelMatcher(query), collapsedIds, searchableNodeTypes);
}

function filterSidebarTreeWithMatcher(nodes: TreeNode[], matchLabel: SidebarLabelMatcher, collapsedIds: ReadonlySet<string>, searchableNodeTypes?: ReadonlySet<TreeNodeType>): TreeNode[] {
  const filteredNodes: { node: TreeNode; score: number }[] = [];

  for (const node of nodes) {
    if (node.type === "object-browser" && node.hiddenChildren) {
      const matches = node.hiddenChildren.map((child) => ({ node: child, score: matchLabel(normalizedLabel(child))?.score ?? 0 })).filter((match) => match.score > 0);
      filteredNodes.push(...matches);
      continue;
    }

    const label = normalizedLabel(node);
    const canSelfMatch = !searchableNodeTypes || searchableNodeTypes.has(node.type);
    const selfMatch = canSelfMatch ? bestMatch(matchLabel, label, node.comment) : null;
    const preservesSubtree = !!selfMatch && preserveMatchedSubtreeTypes.has(node.type);
    const filteredChildren = preservesSubtree ? node.children : node.children ? filterSidebarTreeWithMatcher(node.children, matchLabel, collapsedIds, searchableNodeTypes) : undefined;

    if (selfMatch || (filteredChildren && filteredChildren.length > 0)) {
      if (!node.children) {
        filteredNodes.push({ node, score: selfMatch?.score ?? 0 });
      } else {
        const children = filteredChildren ?? [];
        filteredNodes.push({
          node: {
            ...node,
            children,
            isExpanded: children.length > 0 && !collapsedIds.has(node.id),
          },
          score: selfMatch?.score ?? 0,
        });
      }
    }
  }

  filteredNodes.sort((a, b) => b.score - a.score);
  return filteredNodes.map((match) => match.node);
}

export function filterSidebarSearchRootsByConnectionState(nodes: TreeNode[], connectedIds: ReadonlySet<string>): TreeNode[] {
  return nodes.filter((node) => {
    if (node.type === "connection-group" || node.type === "connection") return true;
    return node.connectionId ? connectedIds.has(node.connectionId) : true;
  });
}
