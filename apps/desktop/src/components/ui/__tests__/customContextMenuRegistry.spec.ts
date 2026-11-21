/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_MENU_SCROLL_ROOT_ATTR, createContextMenuRegistry } from "@/components/ui/customContextMenuRegistry";

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

  it("does not close open menus when scroll originates inside a context menu root", () => {
    const documentTarget = document;
    const windowTarget = window;
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeMenu = vi.fn();
    const registration = registry.register(closeMenu);
    registration.setOpen(true);

    const menuRoot = document.createElement("div");
    menuRoot.setAttribute(CONTEXT_MENU_SCROLL_ROOT_ATTR, "");
    document.body.append(menuRoot);

    menuRoot.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).toHaveBeenCalledOnce();

    menuRoot.remove();
    registration.dispose();
  });

  it("atomically reactivates a host after the capture listener clears it", () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const first = registry.register(closeFirst);
    const second = registry.register(closeSecond);

    first.activate();
    documentTarget.dispatchEvent(new Event("contextmenu"));
    first.activate();
    second.activate();

    expect(closeFirst).toHaveBeenCalledTimes(2);
    expect(closeSecond).not.toHaveBeenCalled();

    windowTarget.dispatchEvent(new Event("resize"));
    expect(closeSecond).toHaveBeenCalledOnce();

    first.dispose();
    second.dispose();
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

  it("ignores scroll events from unrelated containers when a trigger target is active", () => {
    const documentTarget = document;
    const windowTarget = window;
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeMenu = vi.fn();
    const registration = registry.register(closeMenu);

    const treeContainer = document.createElement("div");
    treeContainer.id = "tree-scroll-container";
    const treeRow = document.createElement("div");
    treeRow.id = "tree-node";
    treeContainer.append(treeRow);

    const aiChatContainer = document.createElement("div");
    aiChatContainer.id = "ai-chat-viewport";

    document.body.append(treeContainer, aiChatContainer);

    registration.activate(treeRow);

    // Unrelated container scroll (like streaming AI tokens) must not dismiss the menu
    aiChatContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).not.toHaveBeenCalled();

    // Container enclosing the trigger node scrolling must dismiss the menu
    treeContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).toHaveBeenCalledOnce();

    treeContainer.remove();
    aiChatContainer.remove();
    registration.dispose();
  });

  it("closes when document scrolls or when trigger target is detached", () => {
    const documentTarget = document;
    const windowTarget = window;
    const registry = createContextMenuRegistry(documentTarget, windowTarget);
    const closeMenu = vi.fn();
    const registration = registry.register(closeMenu);

    const trigger = document.createElement("button");
    const container = document.createElement("div");
    container.append(trigger);
    const unrelated = document.createElement("div");
    document.body.append(container, unrelated);

    registration.activate(trigger);

    // Document-level scroll dismisses menu
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).toHaveBeenCalledTimes(1);

    // Reactivate menu
    registration.activate(trigger);

    // Disconnect trigger from DOM
    trigger.remove();

    // Scroll from unrelated container should now close since trigger target is no longer connected
    unrelated.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(closeMenu).toHaveBeenCalledTimes(2);

    container.remove();
    unrelated.remove();
    registration.dispose();
  });
});
