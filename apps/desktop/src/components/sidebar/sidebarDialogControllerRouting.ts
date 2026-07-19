import { reactive, toRaw } from "vue";

/**
 * Build a per-open dialog controller without unwrapping shared dialog refs.
 *
 * Spreading a reactive controller (`{ ...controller }`) unwraps nested refs into
 * plain booleans. The dialog UI then mutates a disconnected copy, while actions
 * still write the module-level refs — so cancel leaves `showCreateDatabaseDialog`
 * stuck `true`, and the next sidebar right-click remounts an already-open dialog.
 */
export function createRoutedSidebarDialogController(
  controller: Record<string, unknown>,
  options: {
    node: unknown;
    wrapAction: (action: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  },
): Record<string, any> {
  const routedController = reactive<Record<string, any>>({});
  for (const [key, value] of Object.entries(toRaw(controller))) {
    if (key === "node") continue;
    if (typeof value === "function") {
      routedController[key] = options.wrapAction(value as (...args: unknown[]) => unknown);
      continue;
    }
    routedController[key] = value;
  }
  routedController.node = options.node;
  return routedController;
}
