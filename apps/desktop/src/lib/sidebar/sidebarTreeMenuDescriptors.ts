import type { Component } from "vue";
import type { DatabaseType, TreeNode, TreeNodeType } from "@/types/database";
import { createSidebarActionTarget, type SidebarActionTarget } from "./sidebarActionTarget";

// Local mirror of the `ContextMenuItem` shape declared inside the
// `<script setup>` block of `@/components/ui/CustomContextMenu.vue`.
// `vue-tsc` with `isolatedModules` does not surface named `export`
// declarations from a `<script setup>` block, so the original
// `import type` from the .vue file fails with TS2614 here. The two
// declarations are intentionally kept in lockstep — see the
// comment on the same field in `CustomContextMenu.vue`.
export interface ContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean | (() => boolean);
  separator?: boolean;
  icon?: Component;
  iconClass?: string;
  shortcut?: string;
  variant?: "default" | "destructive";
  visible?: boolean;
  children?: ContextMenuItem[];
}

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
