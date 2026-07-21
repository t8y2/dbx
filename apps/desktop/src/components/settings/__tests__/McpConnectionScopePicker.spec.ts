// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { ConnectionConfig } from "@/types/database";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`,
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { AlertTriangle: icon, Minus: icon, Plus: icon, Search: icon };
});

vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/TruncatedTextTooltip.vue", async () => ({ default: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("TruncatedTextTooltip", "span") }));

import McpConnectionScopePicker from "@/components/settings/McpConnectionScopePicker.vue";

function connection(id: string): ConnectionConfig {
  return {
    id,
    name: `${id}-name`,
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "test",
    password: "",
  };
}

describe("McpConnectionScopePicker", () => {
  it("separates allowed and available connections and emits direct moves", () => {
    const update = vi.fn();
    const mounted = mountComponent(McpConnectionScopePicker, {
      connections: [connection("one"), connection("two")],
      allowedConnectionIds: ["one"],
      "onUpdate:allowedConnectionIds": update,
    });

    const allowedPane = findOne(mounted.root, (node) => node.props["data-scope-pane"] === "allowed");
    const availablePane = findOne(mounted.root, (node) => node.props["data-scope-pane"] === "available");
    expect(findAll(allowedPane, (node) => node.props["data-stub"] === "TruncatedTextTooltip").map((node) => node.props.text)).toContain("one-name");
    expect(findAll(allowedPane, (node) => node.props["data-stub"] === "TruncatedTextTooltip").map((node) => node.props.text)).not.toContain("two-name");
    expect(findAll(availablePane, (node) => node.props["data-stub"] === "TruncatedTextTooltip").map((node) => node.props.text)).toContain("two-name");

    const add = findOne(availablePane, (node) => node.props["data-connection-id"] === "two");
    dispatch(add, "click");
    expect(update).toHaveBeenCalledWith(["one", "two"]);

    const remove = findOne(allowedPane, (node) => node.props["data-connection-id"] === "one");
    dispatch(remove, "click");
    expect(update).toHaveBeenCalledWith([]);
  });

  it("keeps dynamic allow-all distinct from an explicit current-connection list", () => {
    const update = vi.fn();
    const mounted = mountComponent(McpConnectionScopePicker, {
      connections: [connection("one"), connection("two")],
      allowedConnectionIds: null,
      "onUpdate:allowedConnectionIds": update,
    });
    const modeButtons = findAll(mounted.root, (node) => {
      return node.type === "button" && node.props["class"]?.includes("settings-choice-card");
    });

    expect(modeButtons.find((node) => node.props["data-scope-mode"] === "all")?.props["class"]?.includes("settings-choice-card--selected")).toBe(true);
    expect(modeButtons.find((node) => node.props["data-scope-mode"] === "all")?.props.role).toBe("radio");
    expect(modeButtons.find((node) => node.props["data-scope-mode"] === "all")?.props["aria-checked"]).toBe(true);
    expect(modeButtons.find((node) => node.props["data-scope-mode"] === "selected")?.props.tabindex).toBe(-1);
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && node.props["data-scope-mode"] === "selected"),
      "click",
    );
    expect(update).toHaveBeenCalledWith(["one", "two"]);
  });

  it("supports radio-group arrow-key selection", () => {
    const update = vi.fn();
    const mounted = mountComponent(McpConnectionScopePicker, {
      connections: [connection("one"), connection("two")],
      allowedConnectionIds: null,
      "onUpdate:allowedConnectionIds": update,
    });
    const allMode = findOne(mounted.root, (node) => node.type === "button" && node.props["data-scope-mode"] === "all");

    const event = dispatch(allMode, "keydown", { key: "ArrowRight" });

    expect(event.defaultPrevented).toBe(true);
    expect(update).toHaveBeenCalledWith(["one", "two"]);
  });

  it("shows unavailable allowlist entries only in the allowed pane", () => {
    const mounted = mountComponent(McpConnectionScopePicker, {
      connections: [connection("one")],
      allowedConnectionIds: ["one", "missing-id"],
    });
    const allowedPane = findOne(mounted.root, (node) => node.props["data-scope-pane"] === "allowed");
    const availablePane = findOne(mounted.root, (node) => node.props["data-scope-pane"] === "available");
    expect(findAll(allowedPane, (node) => node.props["data-stub"] === "TruncatedTextTooltip").map((node) => node.props.text)).toContain("missing-id");
    expect(findAll(availablePane, (node) => node.props["data-stub"] === "TruncatedTextTooltip").map((node) => node.props.text)).not.toContain("missing-id");
  });
});
