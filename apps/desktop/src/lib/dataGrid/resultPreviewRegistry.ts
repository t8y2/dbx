import type { Component } from "vue";
import type { QueryResult } from "@/types/database";

/**
 * Configuration returned by a preview action when the user activates it.
 * DataGrid renders the component with the given props in a dialog.
 */
export interface PreviewDialogConfig {
  component: Component;
  props: Record<string, any>;
}

/**
 * Context passed to a preview action's `execute` method.
 */
export interface PreviewActionContext {
  result: QueryResult;
  selectedRowIds: readonly number[];
  displayRowRefs: readonly { id: number; sourceIndex: number; isNew: boolean }[];
}

/**
 * A preview action that can appear in the result grid's context menu.
 * Handlers register themselves and are discovered by DataGrid via the registry.
 */
export interface PreviewAction {
  /** Unique identifier for this action. */
  id: string;
  /** Display label in the context menu. */
  label: string;
  /** Optional icon component for the menu item. */
  icon?: Component;
  /** Check whether this action should be shown for the given query result. */
  isAvailable(result: Pick<QueryResult, "columns" | "column_types">): boolean;
  /**
   * Execute the action. Returns a dialog configuration to render, or null
   * if nothing to show (e.g. no applicable data in selected rows).
   */
  execute(ctx: PreviewActionContext): PreviewDialogConfig | null;
}

const actions = new Map<string, PreviewAction>();

/**
 * Register a preview action that will be offered in the result grid
 * context menu when its `isAvailable` check passes.
 */
export function registerPreviewAction(action: PreviewAction): void {
  actions.set(action.id, action);
}

/**
 * Get all registered actions that are applicable for the given result.
 */
export function getApplicablePreviewActions(result: Pick<QueryResult, "columns" | "column_types">): PreviewAction[] {
  const applicable: PreviewAction[] = [];
  for (const action of actions.values()) {
    if (action.isAvailable(result)) {
      applicable.push(action);
    }
  }
  return applicable;
}
