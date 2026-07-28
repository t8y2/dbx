export type ContextMenuClose = () => void;

/** Marker attribute on scrollable context menu / submenu roots. */
export const CONTEXT_MENU_SCROLL_ROOT_ATTR = "data-dbx-context-menu";

export function isContextMenuInternalScroll(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(`[${CONTEXT_MENU_SCROLL_ROOT_ATTR}]`) !== null;
}

export interface ContextMenuRegistration {
  setOpen(open: boolean): void;
  dispose(): void;
}

export interface ContextMenuRegistry {
  register(close: ContextMenuClose): ContextMenuRegistration;
}

export function createContextMenuRegistry(documentTarget: EventTarget, windowTarget: EventTarget): ContextMenuRegistry {
  const openMenus = new Set<ContextMenuClose>();
  let hostCount = 0;
  let listenersAttached = false;

  function closeAll() {
    const closers = [...openMenus];
    openMenus.clear();
    for (const close of closers) close();
  }

  function closeAllOnScroll(event: Event) {
    // Ignore scroll that originates from within an open menu/submenu.
    if (isContextMenuInternalScroll(event)) return;
    closeAll();
  }

  function attachListeners() {
    if (listenersAttached) return;
    documentTarget.addEventListener("contextmenu", closeAll, true);
    documentTarget.addEventListener("scroll", closeAllOnScroll, true);
    windowTarget.addEventListener("resize", closeAll);
    listenersAttached = true;
  }

  function detachListeners() {
    if (!listenersAttached) return;
    documentTarget.removeEventListener("contextmenu", closeAll, true);
    documentTarget.removeEventListener("scroll", closeAllOnScroll, true);
    windowTarget.removeEventListener("resize", closeAll);
    listenersAttached = false;
    openMenus.clear();
  }

  return {
    register(close) {
      hostCount += 1;
      attachListeners();
      let disposed = false;

      return {
        setOpen(open) {
          if (disposed) return;
          if (open) openMenus.add(close);
          else openMenus.delete(close);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          openMenus.delete(close);
          hostCount -= 1;
          if (hostCount === 0) detachListeners();
        },
      };
    },
  };
}

let globalContextMenuRegistry: ContextMenuRegistry | undefined;

export function registerGlobalContextMenu(close: ContextMenuClose): ContextMenuRegistration {
  globalContextMenuRegistry ??= createContextMenuRegistry(document, window);
  return globalContextMenuRegistry.register(close);
}
