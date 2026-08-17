import type { InjectionKey } from "vue";
import type { TreeNode } from "@/types/database";

export interface SidebarTreeContext {
  getVisibleNodes: () => TreeNode[];
  getVisibleNodeIndex: (id: string) => number;
  isSearchProjectionActive?: () => boolean;
  getTreeLoadSearchOptions?: (node: TreeNode) => { searchFilter: string; allowGlobalSearchMismatch: true; expectedSidebarSearchQuery: string } | undefined;
  setTableSearchQuery?: (parentNodeId: string, query: string, local: boolean) => void;
  refreshTableSearchIndex?: (parentNodeId: string) => void;
  registerPasteHandler?: (nodeId: string, callback: () => void) => () => void;
}

export const sidebarTreeContextKey: InjectionKey<SidebarTreeContext> = Symbol("sidebar-tree-context");
