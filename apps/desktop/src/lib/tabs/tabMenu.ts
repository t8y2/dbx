import { Copy, Crosshair, Pencil, Pin, X } from "@lucide/vue";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import type { QueryTab } from "@/types/database";

export function createRenameDuplicateTabItems(options: { tab: QueryTab; t: (key: string) => string; canRename: boolean; onRename: () => void; onDuplicate: () => void }): ContextMenuItem[] {
  return [
    ...(options.canRename
      ? [
          {
            label: options.t("contextMenu.renameTab"),
            action: options.onRename,
            icon: Pencil,
          },
        ]
      : []),
    {
      label: options.t("contextMenu.duplicateTab"),
      action: options.onDuplicate,
      icon: Copy,
      visible: options.canRename,
    },
  ];
}

export function createLocateTabMenuItem(options: { t: (key: string) => string; visible: boolean; onLocate: () => void }): ContextMenuItem {
  return {
    label: options.t("sidebar.locateActiveTab"),
    action: options.onLocate,
    icon: Crosshair,
    visible: options.visible,
  };
}

export function createPinTabMenuItem(options: { label: string; iconClass?: string; onToggle: () => void }): ContextMenuItem {
  return {
    label: options.label,
    action: options.onToggle,
    icon: Pin,
    ...(options.iconClass ? { iconClass: options.iconClass } : {}),
  };
}

export function createCloseTabMenuItem(options: { label: string; onClose: () => void }): ContextMenuItem {
  return { label: options.label, action: options.onClose, icon: X };
}

export function createCloseOtherTabMenuItem(options: { label: string; disabled?: boolean; shortcut?: string; onClose: () => void }): ContextMenuItem {
  return {
    label: options.label,
    action: options.onClose,
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
    ...(options.shortcut ? { shortcut: options.shortcut } : {}),
    icon: X,
  };
}

export function createCloseRightTabMenuItem(options: { label: string; disabled?: boolean; onClose: () => void }): ContextMenuItem {
  return {
    label: options.label,
    action: options.onClose,
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
    icon: X,
  };
}

export function createCloseLeftTabMenuItem(options: { label: string; disabled?: boolean; onClose: () => void }): ContextMenuItem {
  return {
    label: options.label,
    action: options.onClose,
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
    icon: X,
  };
}

export function createCloseAllTabMenuItem(options: { label: string; variant?: "destructive"; onClose: () => void }): ContextMenuItem {
  return {
    label: options.label,
    action: options.onClose,
    ...(options.variant ? { variant: options.variant } : {}),
    icon: X,
  };
}
