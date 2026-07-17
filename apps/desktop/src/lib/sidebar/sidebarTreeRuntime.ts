import type { ComponentPublicInstance, InjectionKey } from "vue";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";
import { createSidebarActionTarget, type SidebarActionTarget } from "./sidebarActionTarget";

export interface SidebarSelectionSnapshot {
  readonly ids: readonly string[];
  readonly targets: readonly SidebarActionTarget[];
}

export interface SidebarTreeRuntimeGeneration {
  readonly runtimeId: symbol;
  readonly generation: number;
}

export interface SidebarTreeRuntimeHost {
  buildContextMenu(node: TreeNode): ContextMenuItem[];
  handleRowClick(node: TreeNode, clickDetail: number): void;
  handleRowDoubleClick(node: TreeNode, event: MouseEvent): void;
  handleRowKeydown(node: TreeNode, event: KeyboardEvent): void;
  openDataInNewTab(node: TreeNode): void;
  requestPaste(node: TreeNode): boolean;
  toggleNode(node: TreeNode): void;
}

export type SidebarTreeRuntimeHostInstance = ComponentPublicInstance & SidebarTreeRuntimeHost;

export interface SidebarTreeRuntime {
  readonly runtimeId: symbol;
  readonly diagnostics: {
    readonly hostBindings: number;
    readonly menuBuilds: number;
  };
  bindHost(host: SidebarTreeRuntimeHost | null): void;
  beginAction(): SidebarTreeRuntimeGeneration;
  isCurrent(token: SidebarTreeRuntimeGeneration): boolean;
  buildContextMenu(node: TreeNode): ContextMenuItem[];
  handleRowClick(node: TreeNode, clickDetail: number): void;
  handleRowDoubleClick(node: TreeNode, event: MouseEvent): void;
  handleRowKeydown(node: TreeNode, event: KeyboardEvent): void;
  openDataInNewTab(node: TreeNode): void;
  requestPaste(node: TreeNode): boolean;
  toggleNode(node: TreeNode): void;
  dispose(): void;
}

export const sidebarTreeRuntimeKey: InjectionKey<SidebarTreeRuntime> = Symbol("sidebar-tree-runtime");

export function createSidebarSelectionSnapshot(nodes: readonly TreeNode[], selectedIds: readonly string[]): SidebarSelectionSnapshot {
  const selected = new Set(selectedIds);
  const targets = nodes.filter((node) => selected.has(node.id)).map(createSidebarActionTarget);
  return Object.freeze({
    ids: Object.freeze([...selectedIds]),
    targets: Object.freeze(targets),
  });
}

export function createSidebarTreeRuntime(): SidebarTreeRuntime {
  const runtimeId = Symbol("sidebar-tree-runtime-instance");
  let host: SidebarTreeRuntimeHost | null = null;
  let generation = 0;
  let disposed = false;
  let hostBindings = 0;
  let menuBuilds = 0;

  function currentHost(): SidebarTreeRuntimeHost | null {
    return disposed ? null : host;
  }

  return {
    runtimeId,
    get diagnostics() {
      return { hostBindings, menuBuilds };
    },
    bindHost(nextHost) {
      if (disposed) return;
      host = nextHost;
      if (nextHost) hostBindings += 1;
    },
    beginAction() {
      generation += 1;
      return Object.freeze({ runtimeId, generation });
    },
    isCurrent(token) {
      return !disposed && token.runtimeId === runtimeId && token.generation === generation;
    },
    buildContextMenu(node) {
      menuBuilds += 1;
      return currentHost()?.buildContextMenu(node) ?? [];
    },
    handleRowClick(node, clickDetail) {
      currentHost()?.handleRowClick(node, clickDetail);
    },
    handleRowDoubleClick(node, event) {
      currentHost()?.handleRowDoubleClick(node, event);
    },
    handleRowKeydown(node, event) {
      currentHost()?.handleRowKeydown(node, event);
    },
    openDataInNewTab(node) {
      currentHost()?.openDataInNewTab(node);
    },
    requestPaste(node) {
      return currentHost()?.requestPaste(node) ?? false;
    },
    toggleNode(node) {
      currentHost()?.toggleNode(node);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      host = null;
    },
  };
}
