import { describe, expect, it, vi } from "vitest";
import { parseDynamicMenuResponse, renderDynamicMenuEntries } from "./dynamicContextMenu";

describe("dynamic plugin context menus", () => {
  it("renders a state-dependent native submenu and dispatches only validated actions", () => {
    const entries = parseDynamicMenuResponse({
      items: [
        {
          label: "Tunnels",
          children: [
            { label: "Manage", action: { type: "open-workbench", workbench: "ssh.tunnels", presentation: "dialog" } },
            { label: "Start saved", action: { type: "invoke", id: "start-all" } },
            { label: "Hidden", visible: false },
          ],
        },
      ],
    });
    expect(entries).not.toBeNull();
    const activate = vi.fn();
    const items = renderDynamicMenuEntries(entries!, activate);
    expect(items[0].children?.map((child) => child.label)).toEqual(["Manage", "Start saved"]);
    items[0].children?.[1].action?.();
    expect(activate).toHaveBeenCalledWith({ type: "invoke", id: "start-all" }, "Start saved");
    items[0].children?.[0].action?.();
    expect(activate).toHaveBeenCalledWith({ type: "open-workbench", workbench: "ssh.tunnels", presentation: "dialog" }, "Manage");
  });

  it("rejects nested menus, arbitrary methods, invalid types and oversized responses", () => {
    expect(parseDynamicMenuResponse({ items: [{ label: "Parent", children: [{ label: "Nested", children: [] }] }] })).toBeNull();
    expect(parseDynamicMenuResponse({ items: [{ label: "Run", action: { type: "invoke", method: "arbitrary" } }] })).toBeNull();
    expect(parseDynamicMenuResponse({ items: [{ label: "Run", action: { type: "invoke", id: "start", reopenConnectionOnMissing: "yes" } }] })).toBeNull();
    expect(parseDynamicMenuResponse({ items: [{ label: "Manage", action: { type: "open-workbench", workbench: "ssh.tunnels", presentation: "window" } }] })).toBeNull();
    expect(parseDynamicMenuResponse({ items: [{ label: "Run", enabled: "yes" }] })).toBeNull();
    expect(parseDynamicMenuResponse({ items: Array.from({ length: 25 }, () => ({ label: "X" })) })).toBeNull();
  });

  it("hides empty contributions and disables parents with no visible children", () => {
    expect(parseDynamicMenuResponse({ items: [] })).toEqual([]);
    const entries = parseDynamicMenuResponse({ items: [{ label: "Tunnels", children: [{ label: "Hidden", visible: false }] }] });
    expect(renderDynamicMenuEntries(entries!, vi.fn())).toEqual([expect.objectContaining({ label: "Tunnels", disabled: true, children: [] })]);
  });
});
