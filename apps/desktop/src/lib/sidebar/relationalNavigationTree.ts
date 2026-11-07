import type { TreeNode } from "@/types/database";
import { relationalNavigationContainerKey, type RelationalNavigationContainer, type RelationalNavigationSelection } from "./relationalNavigationScope";

export interface RelationalNavigationSource {
  node: TreeNode;
  name: string;
  shared?: boolean;
}

export function projectRelationalNavigationGroups(options: {
  container: RelationalNavigationContainer;
  selection: RelationalNavigationSelection;
  sources: readonly RelationalNavigationSource[];
  discoveryComplete: boolean;
  isLoaded: (node: TreeNode) => boolean;
  expandedIds: ReadonlySet<string>;
}): TreeNode[] {
  const { container, selection, sources, discoveryComplete, isLoaded, expandedIds } = options;
  const selected = sources.filter((source) => source.shared || selection.kind === "all" || source.name === selection.name);
  const key = relationalNavigationContainerKey(container);
  const groups = new Map<string, { node: TreeNode; complete: boolean }>();
  for (const source of selected) {
    const sourceNode = source.node;
    const groupKey = JSON.stringify([sourceNode.type, sourceNode.label, sourceNode.nativeJobPage?.kind ?? null]);
    let group = groups.get(groupKey);
    if (!group) {
      const id = `__relational_navigation:${JSON.stringify([key, groupKey])}`;
      group = {
        node: {
          id,
          type: sourceNode.type,
          label: sourceNode.label,
          comment: sourceNode.comment,
          connectionId: container.connectionId,
          database: container.database,
          catalog: container.catalog,
          linkedServer: container.linkedServer,
          linkedCatalog: container.linkedCatalog,
          linkedSchema: container.linkedSchema,
          isExpanded: expandedIds.has(id),
          children: [],
          relationalNavigationSources: [],
          relationalNavigationSelection: selection,
        },
        complete: discoveryComplete,
      };
      groups.set(groupKey, group);
    }
    if (group.node.relationalNavigationSources!.includes(sourceNode.id)) continue;
    group.node.relationalNavigationSources!.push(sourceNode.id);
    group.node.isLoading ||= sourceNode.isLoading;
    if (sourceNode.oracleNavigationStatus) {
      const status = sourceNode.oracleNavigationStatus;
      const previous = group.node.oracleNavigationStatus;
      const reason = [previous?.reason, `${source.shared ? "PUBLIC" : source.name}${status.reason ? `: ${status.reason}` : ""}`].filter(Boolean).join("\n");
      group.node.oracleNavigationStatus = { ...(!previous || previous.kind === "unknown" || previous.kind === "truncated" ? status : previous), reason };
    }
    const children = sourceNode.children ?? [];
    group.complete &&= isLoaded(sourceNode) && sourceNode.objectCount !== undefined && !sourceNode.isLoading && !sourceNode.oracleNavigationStatus && !children.some((child) => child.type === "load-more") && !sourceNode.hiddenChildren?.some((child) => child.type === "load-more");
    group.node.objectCount = (group.node.objectCount ?? 0) + (sourceNode.objectCount ?? 0);
    if (sourceNode.type === "native-job-scheduler") {
      continue;
    }
    for (const child of children) {
      group.node.children!.push(source.shared || selection.kind === "all" ? { ...child, relationalNavigationOwner: source.shared ? "PUBLIC" : source.name } : child);
    }
  }
  for (const group of groups.values()) {
    if (group.node.type === "native-job-scheduler") {
      group.node.children = projectRelationalNavigationGroups({ ...options, sources: selected.filter((source) => source.node.type === "native-job-scheduler").flatMap((source) => (source.node.children ?? []).map((node) => ({ ...source, node }))) });
      group.complete = false;
    }
    if (!group.complete) delete group.node.objectCount;
  }
  return [...groups.values()].map((group) => group.node);
}
