export const NACOS_NAMESPACES_CHANGED_EVENT = "dbx:nacos-namespaces-changed";

export interface NacosNamespacesChangedDetail {
  connectionId: string;
}

export interface NacosNamespaceRequestGuard {
  invalidate: () => void;
  start: (connectionId: string) => number;
  isCurrent: (requestId: number, connectionId: string) => boolean;
}

export function createNacosNamespaceRequestGuard(): NacosNamespaceRequestGuard {
  let latestRequestId = 0;
  let latestConnectionId = "";

  return {
    invalidate: () => {
      latestRequestId++;
      latestConnectionId = "";
    },
    start: (connectionId) => {
      latestConnectionId = connectionId;
      return ++latestRequestId;
    },
    isCurrent: (requestId, connectionId) => requestId === latestRequestId && connectionId === latestConnectionId,
  };
}

export function notifyNacosNamespacesChanged(connectionId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<NacosNamespacesChangedDetail>(NACOS_NAMESPACES_CHANGED_EVENT, { detail: { connectionId } }));
}

export function subscribeNacosNamespacesChanged(listener: (detail: NacosNamespacesChangedDetail) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleEvent = (event: Event) => listener((event as CustomEvent<NacosNamespacesChangedDetail>).detail);
  window.addEventListener(NACOS_NAMESPACES_CHANGED_EVENT, handleEvent);
  return () => window.removeEventListener(NACOS_NAMESPACES_CHANGED_EVENT, handleEvent);
}
