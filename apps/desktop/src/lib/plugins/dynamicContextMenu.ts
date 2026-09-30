import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";

export type DynamicMenuAction = { type: "invoke"; id: string; reopenConnectionOnMissing?: boolean } | { type: "open-workbench"; workbench: string; presentation?: "dialog" };

export interface DynamicMenuEntry {
  label: string;
  visible?: boolean;
  enabled?: boolean;
  checked?: boolean;
  action?: DynamicMenuAction;
  children?: DynamicMenuEntry[];
}

const IDENTIFIER = /^[a-zA-Z0-9._:/-]{1,256}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseAction(value: unknown): DynamicMenuAction | undefined {
  const object = record(value);
  if (!object) return undefined;
  if (object.type === "invoke" && typeof object.id === "string" && IDENTIFIER.test(object.id)) {
    if (object.reopenConnectionOnMissing !== undefined && typeof object.reopenConnectionOnMissing !== "boolean") return undefined;
    return { type: "invoke", id: object.id, ...(object.reopenConnectionOnMissing === true ? { reopenConnectionOnMissing: true } : {}) };
  }
  if (object.type === "open-workbench" && typeof object.workbench === "string" && IDENTIFIER.test(object.workbench)) {
    if (object.presentation !== undefined && object.presentation !== "dialog") return undefined;
    return { type: "open-workbench", workbench: object.workbench, ...(object.presentation === "dialog" ? { presentation: "dialog" as const } : {}) };
  }
  return undefined;
}

function parseEntry(value: unknown, depth: number): DynamicMenuEntry | null {
  const object = record(value);
  if (!object || typeof object.label !== "string" || !object.label.trim() || object.label.length > 120) return null;
  if (object.visible !== undefined && typeof object.visible !== "boolean") return null;
  if (object.enabled !== undefined && typeof object.enabled !== "boolean") return null;
  if (object.checked !== undefined && typeof object.checked !== "boolean") return null;
  if (object.action !== undefined && !parseAction(object.action)) return null;
  if (object.children !== undefined && (depth !== 0 || !Array.isArray(object.children) || object.children.length > 40 || object.action !== undefined)) return null;
  const children = Array.isArray(object.children) ? object.children.map((child) => parseEntry(child, 1)) : undefined;
  if (children?.some((child) => child === null)) return null;
  return {
    label: object.label.trim(),
    visible: object.visible as boolean | undefined,
    enabled: object.enabled as boolean | undefined,
    checked: object.checked as boolean | undefined,
    action: parseAction(object.action),
    children: children as DynamicMenuEntry[] | undefined,
  };
}

/** Reject malformed or oversized sidecar responses before they reach the native menu. */
export function parseDynamicMenuResponse(value: unknown): DynamicMenuEntry[] | null {
  const object = record(value);
  if (!object || !Array.isArray(object.items) || object.items.length > 24) return null;
  const items = object.items.map((item) => parseEntry(item, 0));
  return items.some((item) => item === null) ? null : (items as DynamicMenuEntry[]);
}

export function renderDynamicMenuEntries(entries: DynamicMenuEntry[], activate: (action: DynamicMenuAction, label: string) => void): ContextMenuItem[] {
  return entries
    .filter((entry) => entry.visible !== false)
    .map((entry) => {
      const children = entry.children ? renderDynamicMenuEntries(entry.children, activate) : undefined;
      return {
        label: entry.label,
        disabled: entry.enabled === false || (children !== undefined && children.length === 0),
        checked: entry.checked,
        action: entry.action ? () => activate(entry.action!, entry.label) : undefined,
        children,
      };
    });
}
