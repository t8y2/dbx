import { afterEach, describe, expect, it, vi } from "vitest";
import { createNacosNamespaceRequestGuard, NACOS_NAMESPACES_CHANGED_EVENT, notifyNacosNamespacesChanged, subscribeNacosNamespacesChanged } from "@/lib/nacos/nacosNamespaceCache";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Nacos namespace request guard", () => {
  it("prevents an older response from replacing a newer namespace list", async () => {
    const guard = createNacosNamespaceRequestGuard();
    const committedLists: string[][] = [];
    let resolveOlder!: (value: string[]) => void;
    let resolveNewer!: (value: string[]) => void;
    const olderResponse = new Promise<string[]>((resolve) => {
      resolveOlder = resolve;
    });
    const newerResponse = new Promise<string[]>((resolve) => {
      resolveNewer = resolve;
    });
    const olderRequest = guard.start("conn-1");
    const commitOlder = olderResponse.then((namespaces) => {
      if (guard.isCurrent(olderRequest, "conn-1")) committedLists.push(namespaces);
    });
    const newerRequest = guard.start("conn-1");
    const commitNewer = newerResponse.then((namespaces) => {
      if (guard.isCurrent(newerRequest, "conn-1")) committedLists.push(namespaces);
    });

    resolveNewer(["public", "new-space"]);
    await commitNewer;
    resolveOlder(["public"]);
    await commitOlder;

    expect(committedLists).toEqual([["public", "new-space"]]);
  });

  it("rejects pending responses after invalidation or a connection change", () => {
    const guard = createNacosNamespaceRequestGuard();
    const request = guard.start("conn-1");

    expect(guard.isCurrent(request, "conn-2")).toBe(false);

    guard.invalidate();

    expect(guard.isCurrent(request, "conn-1")).toBe(false);
  });
});

describe("Nacos namespace change events", () => {
  it("notifies open views for the affected connection and supports unsubscribe", () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const handlers = listeners.get(type) ?? new Set();
        handlers.add(listener);
        listeners.set(type, handlers);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        listeners.get(event.type)?.forEach((listener) => listener(event));
        return true;
      },
    });
    const listener = vi.fn();
    const unsubscribe = subscribeNacosNamespacesChanged(listener);

    notifyNacosNamespacesChanged("conn-1");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ connectionId: "conn-1" });
    expect(listeners.get(NACOS_NAMESPACES_CHANGED_EVENT)?.size).toBe(1);

    unsubscribe();
    notifyNacosNamespacesChanged("conn-1");

    expect(listener).toHaveBeenCalledOnce();
    expect(listeners.get(NACOS_NAMESPACES_CHANGED_EVENT)?.size).toBe(0);
  });
});
