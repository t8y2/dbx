export type SidebarPasteHandler = () => void;

export interface SidebarPasteHandlerRegistry {
  register: (nodeId: string, handler: SidebarPasteHandler) => () => void;
  request: (nodeId: string) => boolean;
}

export function createSidebarPasteHandlerRegistry(): SidebarPasteHandlerRegistry {
  const handlersByNodeId = new Map<string, Set<SidebarPasteHandler>>();

  function register(nodeId: string, handler: SidebarPasteHandler) {
    let handlers = handlersByNodeId.get(nodeId);
    if (!handlers) {
      handlers = new Set();
      handlersByNodeId.set(nodeId, handlers);
    }
    handlers.add(handler);

    return () => {
      const currentHandlers = handlersByNodeId.get(nodeId);
      if (!currentHandlers) return;
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) handlersByNodeId.delete(nodeId);
    };
  }

  function request(nodeId: string): boolean {
    const handlers = handlersByNodeId.get(nodeId);
    if (!handlers?.size) return false;

    // The sticky database row may duplicate a virtualized row. Prefer the most
    // recently registered live instance while keeping older owners as fallback.
    let activeHandler: SidebarPasteHandler | undefined;
    for (const handler of handlers) activeHandler = handler;
    activeHandler?.();
    return true;
  }

  return { register, request };
}
