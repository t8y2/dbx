export type PluginNativeFileDragType = "enter" | "over" | "leave" | "drop";

export interface PluginWorkbenchNativeFileTarget {
  acceptsNativeFileDrag(): boolean;
  forwardNativeFileDrag(type: PluginNativeFileDragType, paths?: string[]): Promise<void>;
}

const targets = new Map<string, PluginWorkbenchNativeFileTarget>();

export function registerPluginWorkbenchNativeFileTarget(workbenchId: string, target: PluginWorkbenchNativeFileTarget): () => void {
  targets.set(workbenchId, target);
  return () => {
    if (targets.get(workbenchId) === target) targets.delete(workbenchId);
  };
}

export async function forwardActivePluginNativeFileDrag(activeTabId: string | null | undefined, type: PluginNativeFileDragType, paths: string[] = []): Promise<boolean> {
  if (!activeTabId) return false;
  const target = targets.get(activeTabId);
  if (!target?.acceptsNativeFileDrag()) return false;
  await target.forwardNativeFileDrag(type, paths);
  return true;
}

export function clearPluginWorkbenchNativeFileTargetsForTests(): void {
  targets.clear();
}
