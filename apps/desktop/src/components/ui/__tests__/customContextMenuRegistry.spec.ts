import { describe, expect, it, vi } from "vitest";
import { createContextMenuRegistry } from "@/components/ui/customContextMenuRegistry";

function callsFor(spy: ReturnType<typeof vi.spyOn>, eventName: string) {
  return spy.mock.calls.filter(([name]) => name === eventName);
}

describe("customContextMenuRegistry", () => {
  it("shares one global listener set across all registered hosts", () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    const documentAdd = vi.spyOn(documentTarget, "addEventListener");
    const windowAdd = vi.spyOn(windowTarget, "addEventListener");
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const registrations = Array.from({ length: 200 }, (_, index) => registry.register(index === 0 ? closeFirst : index === 1 ? closeSecond : vi.fn()));

    expect(callsFor(documentAdd, "contextmenu")).toHaveLength(1);
    expect(callsFor(documentAdd, "scroll")).toHaveLength(1);
    expect(callsFor(windowAdd, "resize")).toHaveLength(1);

    registrations[0].setOpen(true);
    registrations[1].setOpen(true);
    documentTarget.dispatchEvent(new Event("contextmenu"));
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).toHaveBeenCalledOnce();

    documentTarget.dispatchEvent(new Event("scroll"));
    windowTarget.dispatchEvent(new Event("resize"));
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).toHaveBeenCalledOnce();

    registrations.forEach((registration) => registration.dispose());
  });

  it("removes disposed callbacks and detaches listeners after the final host", () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    const documentRemove = vi.spyOn(documentTarget, "removeEventListener");
    const windowRemove = vi.spyOn(windowTarget, "removeEventListener");
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeDisposed = vi.fn();
    const closeRemaining = vi.fn();
    const disposed = registry.register(closeDisposed);
    const remaining = registry.register(closeRemaining);

    disposed.setOpen(true);
    remaining.setOpen(true);
    disposed.dispose();
    disposed.dispose();
    documentTarget.dispatchEvent(new Event("scroll"));

    expect(closeDisposed).not.toHaveBeenCalled();
    expect(closeRemaining).toHaveBeenCalledOnce();
    expect(callsFor(documentRemove, "contextmenu")).toHaveLength(0);

    remaining.dispose();
    expect(callsFor(documentRemove, "contextmenu")).toHaveLength(1);
    expect(callsFor(documentRemove, "scroll")).toHaveLength(1);
    expect(callsFor(windowRemove, "resize")).toHaveLength(1);
  });

  it("reattaches a clean listener set after complete teardown", () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    const documentAdd = vi.spyOn(documentTarget, "addEventListener");
    const windowAdd = vi.spyOn(windowTarget, "addEventListener");
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const staleClose = vi.fn();
    const first = registry.register(staleClose);

    first.setOpen(true);
    first.dispose();

    const activeClose = vi.fn();
    const second = registry.register(activeClose);
    second.setOpen(true);
    windowTarget.dispatchEvent(new Event("resize"));

    expect(staleClose).not.toHaveBeenCalled();
    expect(activeClose).toHaveBeenCalledOnce();
    expect(callsFor(documentAdd, "contextmenu")).toHaveLength(2);
    expect(callsFor(documentAdd, "scroll")).toHaveLength(2);
    expect(callsFor(windowAdd, "resize")).toHaveLength(2);

    second.dispose();
  });
});
