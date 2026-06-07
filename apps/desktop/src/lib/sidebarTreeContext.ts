import type { InjectionKey } from "vue";
import type { TreeNode } from "@/types/database";

export interface SidebarTreeContext {
  getVisibleNodes: () => TreeNode[];
  getVisibleNodeIndex: (id: string) => number;
}

export const sidebarTreeContextKey: InjectionKey<SidebarTreeContext> = Symbol("sidebar-tree-context");
