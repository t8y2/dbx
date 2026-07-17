import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { DatabaseType, TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarActionTarget, type SidebarActionTarget } from "./sidebarActionTarget";

export type SidebarMenuActionId = `${TreeNodeType}:${string}`;

export interface SidebarMenuContext {
  readonly target: SidebarActionTarget;
  readonly selectedNodeIds: readonly string[];
  readonly databaseType?: DatabaseType;
}

export interface SidebarMenuDescriptor {
  readonly id: SidebarMenuActionId;
  readonly label: string;
  readonly disabled: boolean;
  readonly separator: boolean;
  readonly variant: "default" | "destructive";
  readonly children: readonly SidebarMenuDescriptor[];
}

export function createSidebarMenuContext(node: TreeNode, selectedNodeIds: readonly string[], databaseType?: DatabaseType): SidebarMenuContext {
  return Object.freeze({
    target: createSidebarActionTarget(node),
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    databaseType,
  });
}

export function normalizeSidebarMenuDescriptors(context: SidebarMenuContext, items: readonly ContextMenuItem[]): readonly SidebarMenuDescriptor[] {
  const normalize = (entries: readonly ContextMenuItem[], parentPath: string): SidebarMenuDescriptor[] =>
    entries.map((item, index) => {
      const path = parentPath ? `${parentPath}.${index}` : String(index);
      return Object.freeze({
        id: `${context.target.type}:${path}` as SidebarMenuActionId,
        label: item.label,
        disabled: item.disabled === true,
        separator: item.separator === true,
        variant: item.variant ?? "default",
        children: Object.freeze(normalize(item.children ?? [], path)),
      });
    });
  return Object.freeze(normalize(items, ""));
}
