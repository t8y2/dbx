// @vitest-environment happy-dom

import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { PluginMcpToolView, PluginMcpView } from "@/types/mcpCatalog";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`,
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { AlertTriangle: icon, ChevronDown: icon, ChevronRight: icon, Loader2: icon, Puzzle: icon, RefreshCw: icon };
});

vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/switch", async () => ({ Switch: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Switch", "button") }));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Dialog: defineComponent({
      name: "Dialog",
      props: { open: Boolean },
      setup(props, { slots }) {
        return () => (props.open ? h("div", { "data-stub": "Dialog" }, slots.default?.()) : null);
      },
    }),
    DialogContent: createPassthroughStub("DialogContent", "div"),
    DialogDescription: createPassthroughStub("DialogDescription", "p"),
    DialogHeader: createPassthroughStub("DialogHeader", "div"),
    DialogTitle: createPassthroughStub("DialogTitle", "h2"),
  };
});

import McpPluginCapabilities from "@/components/settings/McpPluginCapabilities.vue";

function tool(name: string, access: PluginMcpToolView["access"], exposure: PluginMcpToolView["exposure"] = "exposed"): PluginMcpToolView {
  return {
    name,
    description: `${name} description`,
    toolset: "default",
    access,
    exposure,
    parameters: name === "list_dir" ? [{ name: "path", valueType: "string", required: true, description: "Absolute path" }] : [],
  };
}

function plugin(patch: Partial<PluginMcpView> = {}): PluginMcpView {
  return {
    pluginId: "io.dbx.ssh",
    pluginName: "Terminal",
    version: "1.4.0",
    authorAllowsExternal: true,
    hasSavedGrant: true,
    grant: { external: true, ceiling: "write", approvedTools: { list_dir: "read", upload: "write" }, disabledTools: [] },
    toolsets: [{ id: "default", title: null, description: null }],
    tools: [tool("list_dir", "read"), tool("upload", "write"), tool("exec", "full", "aboveCeiling")],
    discoveryError: null,
    ...patch,
  };
}

function mountCards(plugins: PluginMcpView[], save = vi.fn(async (pluginId: string) => plugins.find((entry) => entry.pluginId === pluginId)!), props: Record<string, unknown> = {}) {
  const saved = vi.fn();
  const refresh = vi.fn();
  const mounted = mountComponent(McpPluginCapabilities, { plugins, save, onSaved: saved, onRefresh: refresh, ...props });
  return { mounted, save, saved, refresh };
}

function cardSwitch(root: ReturnType<typeof mountComponent>["root"], pluginId: string) {
  const card = findOne(root, (node) => node.props["data-mcp-plugin"] === pluginId);
  return findAll(card, (node) => node.props["data-stub"] === "Switch").at(-1)!;
}

function flip(node: ReturnType<typeof findOne>, value: boolean) {
  (node.props["onUpdate:modelValue"] as (value: boolean) => void)(value);
}

describe("McpPluginCapabilities", () => {
  it("summarizes each plugin card", () => {
    const { mounted } = mountCards([plugin(), plugin({ pluginId: "io.vendor.k8s", pluginName: "Kubernetes", authorAllowsExternal: false, grant: { ...plugin().grant, external: false } })]);
    const terminal = hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin"] === "io.dbx.ssh"));
    expect(terminal).toContain('settings.mcpPluginToolCount {"exposed":2,"total":3}');
    expect(terminal).toContain("settings.mcpPluginCeilingSummary");
    const k8s = hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin"] === "io.vendor.k8s"));
    expect(k8s).toContain("settings.mcpPluginAuthorClosed");
    expect(cardSwitch(mounted.root, "io.vendor.k8s").props.disabled).toBe(true);
  });

  it("opens the authorization dialog on first enable and saves with approveCurrent", async () => {
    const fresh = plugin({ hasSavedGrant: false, grant: { external: false, ceiling: "full", approvedTools: {}, disabledTools: [] }, tools: [tool("list_dir", "read", "pluginDisabled"), tool("exec", "full", "pluginDisabled")] });
    const { mounted, save } = mountCards([fresh]);
    flip(cardSwitch(mounted.root, "io.dbx.ssh"), true);
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    const dialog = findOne(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined);
    expect(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-level"] === "write").props["aria-pressed"]).toBe(true);
    // Default ceiling caps at write, so exec (full) is shown as hidden.
    expect(hostText(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-tool"] === "exec"))).toContain("settings.mcpPluginAuthorizeExcluded");
    dispatch(
      findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-level"] === "full"),
      "click",
    );
    await nextTick();
    expect(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-level"] === "full").props["aria-pressed"]).toBe(true);
    expect(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-level"] === "write").props["aria-pressed"]).toBe(false);
    expect(hostText(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-tool"] === "exec"))).toContain("settings.mcpPluginAuthorizeIncluded");
    dispatch(
      findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-confirm"] !== undefined),
      "click",
    );
    await nextTick();
    expect(save).toHaveBeenCalledWith("io.dbx.ssh", { external: true, ceiling: "full", approvedTools: {}, disabledTools: [] }, true);
  });

  it("switches a reviewed plugin off and on without the dialog", async () => {
    const { mounted, save } = mountCards([plugin()]);
    flip(cardSwitch(mounted.root, "io.dbx.ssh"), false);
    await nextTick();
    expect(save).toHaveBeenCalledWith("io.dbx.ssh", { external: false, ceiling: "write", approvedTools: { list_dir: "read", upload: "write" }, disabledTools: [] }, false);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined)).toEqual([]);
  });

  it("flags pending tools and routes review through the dialog", async () => {
    const pending = plugin({ tools: [tool("list_dir", "read"), tool("new_upload", "write", "pendingApproval")] });
    const { mounted } = mountCards([pending]);
    expect(hostText(mounted.root)).toContain('settings.mcpPluginPendingTools {"count":1}');
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-review"] !== undefined),
      "click",
    );
    await nextTick();
    const dialog = findOne(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined);
    expect(hostText(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-tool"] === "new_upload"))).toContain("settings.mcpPluginExposure.pendingApproval");
  });

  it("edits ceiling and single tools in the detail and shows tool parameters", async () => {
    const { mounted, save } = mountCards([plugin()]);
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-open"] !== undefined),
      "click",
    );
    await nextTick();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-plugin-detail"] !== undefined);
    expect(hostText(findOne(detail, (node) => node.props["data-mcp-plugin-tool"] === "exec"))).toContain("settings.mcpPluginExposure.aboveCeiling");

    dispatch(
      findOne(detail, (node) => node.props["data-mcp-plugin-ceiling-level"] === "full"),
      "click",
    );
    await nextTick();
    expect(save).toHaveBeenLastCalledWith("io.dbx.ssh", expect.objectContaining({ ceiling: "full" }), false);

    const upload = findOne(detail, (node) => node.props["data-mcp-plugin-tool"] === "upload");
    flip(
      findOne(upload, (node) => node.props["data-stub"] === "Switch"),
      false,
    );
    await nextTick();
    expect(save).toHaveBeenLastCalledWith("io.dbx.ssh", expect.objectContaining({ disabledTools: ["upload"] }), false);

    const listDir = findOne(detail, (node) => node.props["data-mcp-plugin-tool"] === "list_dir");
    dispatch(
      findOne(listDir, (node) => node.props["data-mcp-plugin-tool-toggle"] !== undefined),
      "click",
    );
    await nextTick();
    const expanded = hostText(findOne(listDir, (node) => node.props["data-mcp-plugin-tool-detail"] !== undefined));
    expect(expanded).toContain("Absolute path");
    expect(expanded).toContain("settings.mcpAccessLevel.read");
  });

  it("reports save failures on the card list", async () => {
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { mounted } = mountCards([plugin()], save);
    flip(cardSwitch(mounted.root, "io.dbx.ssh"), false);
    await nextTick();
    await nextTick();
    expect(hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin-save-error"] !== undefined))).toContain('settings.mcpPluginSaveFailed {"name":"Terminal","message":"disk full"}');
  });

  it("marks undeclared tools as never exposed and leaves them out of authorization", async () => {
    const undeclared: PluginMcpToolView = { ...tool("raw_exec", "full", "undeclared"), access: null };
    const fresh = plugin({ hasSavedGrant: false, grant: { external: false, ceiling: "read", approvedTools: {}, disabledTools: [] }, tools: [tool("list_dir", "read", "pluginDisabled"), undeclared] });
    const { mounted } = mountCards([fresh]);
    expect(hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin-undeclared"] !== undefined))).toContain('settings.mcpPluginUndeclaredCount {"count":1}');
    flip(cardSwitch(mounted.root, "io.dbx.ssh"), true);
    await nextTick();
    const dialog = findOne(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined);
    expect(findAll(dialog, (node) => node.props["data-mcp-plugin-authorize-tool"] === "raw_exec")).toEqual([]);
    expect(hostText(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-undeclared"] !== undefined))).toContain('"names":"raw_exec"');
  });

  it("shows the empty state", () => {
    const { mounted } = mountCards([]);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugins-empty"] !== undefined)).toHaveLength(1);
  });

  it("renders the selected plugin controls inline without requiring the card dialog", () => {
    const { mounted } = mountCards([plugin(), plugin({ pluginId: "io.vendor.other", pluginName: "Other plugin" })], undefined, { selectedPluginId: "io.dbx.ssh", search: "no matching tool" });
    const inline = findOne(mounted.root, (node) => node.props["data-mcp-plugin-inline"] === "io.dbx.ssh");
    expect(hostText(inline)).toContain("Terminal");
    expect(hostText(inline)).toContain("settings.mcpBrowser.pluginImmediate");
    expect(hostText(inline)).toContain("settings.mcpCapabilitiesFilterPlugin");
    expect(hostText(mounted.root)).not.toContain("Other plugin");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-open"] !== undefined)).toHaveLength(0);
    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Dialog")).toHaveLength(0);
    expect(findAll(inline, (node) => node.props["data-mcp-plugin-tool"] !== undefined)).toHaveLength(3);
    expect(findAll(inline, (node) => node.props["data-mcp-plugin-ceiling-level"] !== undefined)).toHaveLength(3);
    expect(findOne(inline, (node) => node.props["data-mcp-plugin-ceiling-level"] === "write").props["aria-pressed"]).toBe(true);
    expect(findOne(inline, (node) => node.props["data-mcp-plugin-ceiling-level"] === "read").props["aria-pressed"]).toBe(false);
    expect(findOne(inline, (node) => node.props["data-mcp-plugin-master"] !== undefined).props["model-value"]).toBe(true);
  });

  it("keeps author-closed plugin details readable while disabling their controls", () => {
    const closed = plugin({ authorAllowsExternal: false });
    const { mounted } = mountCards([closed], undefined, { selectedPluginId: closed.pluginId });
    expect(hostText(mounted.root)).toContain("settings.mcpPluginAuthorClosed");
    expect(findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined).props.disabled).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-tool"] !== undefined)).toHaveLength(3);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-ceiling-level"] !== undefined).every((node) => node.props.disabled)).toBe(true);
  });

  it("filters by the configured grant while retaining enabled tools that cannot be exposed", () => {
    const view = plugin({
      grant: { ...plugin().grant, disabledTools: ["upload"] },
      tools: [tool("list_dir", "read", "aboveCeiling"), tool("upload", "write", "toolDisabled"), tool("new_tool", "write", "pendingApproval"), tool("undeclared", null, "undeclared")],
    });
    const { mounted } = mountCards([view], undefined, { selectedPluginId: view.pluginId, onlyEnabled: true });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-tool"] !== undefined).map((node) => node.props["data-mcp-plugin-tool"])).toEqual(["list_dir", "new_tool"]);
    expect(hostText(mounted.root)).toContain('settings.mcpPluginToolCount {"exposed":0,"total":4}');
    expect(hostText(mounted.root)).toContain("settings.mcpPluginExposure.aboveCeiling");
    expect(hostText(mounted.root)).toContain("settings.mcpPluginExposure.pendingApproval");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-review"] !== undefined)).toHaveLength(1);
  });

  it("retains the saved grant and displays an inline error after immediate save fails", async () => {
    const view = plugin();
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { mounted, saved } = mountCards([view], save, { selectedPluginId: view.pluginId });
    const master = findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined);
    flip(master, false);
    await nextTick();
    await nextTick();
    expect(saved).not.toHaveBeenCalled();
    expect(master.props["model-value"]).toBe(true);
    expect(master.props.disabled).toBe(false);
    expect(view.grant.external).toBe(true);
    expect(hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin-save-error"] !== undefined))).toContain("disk full");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-saved"] !== undefined)).toHaveLength(0);
  });

  it("locks the selected plugin during save and ignores duplicate changes", async () => {
    const view = plugin();
    let finish!: (value: PluginMcpView) => void;
    const save = vi.fn(
      () =>
        new Promise<PluginMcpView>((resolve) => {
          finish = resolve;
        }),
    );
    const { mounted } = mountCards([view], save, { selectedPluginId: view.pluginId });
    const master = findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined);
    flip(master, false);
    await nextTick();
    expect(master.props.disabled).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Switch").every((node) => node.props.disabled)).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-ceiling-level"] !== undefined).every((node) => node.props.disabled)).toBe(true);
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginSaving");
    flip(master, true);
    const toolSwitch = findOne(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-tool"] === "upload"),
      (node) => node.props["data-stub"] === "Switch",
    );
    flip(toolSwitch, false);
    expect(save).toHaveBeenCalledTimes(1);
    finish({ ...view, grant: { ...view.grant, external: false } });
    await nextTick();
    await nextTick();
    expect(master.props.disabled).toBe(false);
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginSaved");
  });

  it("preserves the parent save lock after remounting while the first request is pending", async () => {
    const view = plugin();
    let finish!: (value: PluginMcpView) => void;
    const save = vi.fn(
      () =>
        new Promise<PluginMcpView>((resolve) => {
          finish = resolve;
        }),
    );
    const first = mountCards([view], save, { selectedPluginId: view.pluginId });
    flip(
      findOne(first.mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined),
      false,
    );
    await nextTick();
    first.mounted.unmount();

    const { mounted } = mountCards([view], save, { selectedPluginId: view.pluginId, pendingPluginIds: [view.pluginId] });
    const master = findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined);
    expect(master.props.disabled).toBe(true);
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginSaving");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-ceiling-level"] !== undefined).every((node) => node.props.disabled)).toBe(true);
    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Switch").every((node) => node.props.disabled)).toBe(true);
    flip(master, false);
    flip(
      findOne(
        findOne(mounted.root, (node) => node.props["data-mcp-plugin-tool"] === "upload"),
        (node) => node.props["data-stub"] === "Switch",
      ),
      false,
    );
    expect(save).toHaveBeenCalledTimes(1);

    finish({ ...view, grant: { ...view.grant, external: false } });
    await nextTick();
    await mounted.setProps({ pendingPluginIds: [], plugins: [{ ...view, grant: { ...view.grant, external: false } }] });
    expect(master.props.disabled).toBe(false);
    expect(master.props["model-value"]).toBe(false);
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-saving"] !== undefined)).toHaveLength(0);
  });

  it("merges external and local save locks per plugin without blocking other plugins", async () => {
    const pending = plugin({ tools: [tool("new_tool", "write", "pendingApproval")] });
    const available = plugin({ pluginId: "io.dbx.other", pluginName: "Other plugin" });
    let finish!: (value: PluginMcpView) => void;
    const save = vi.fn(
      () =>
        new Promise<PluginMcpView>((resolve) => {
          finish = resolve;
        }),
    );
    const { mounted } = mountCards([pending, available], save, { selectedPluginId: pending.pluginId, pendingPluginIds: [pending.pluginId] });
    const review = findOne(mounted.root, (node) => node.props["data-mcp-plugin-review"] !== undefined);
    expect(review.props.disabled).toBe(true);
    dispatch(review, "click");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined)).toHaveLength(0);
    await mounted.setProps({ selectedPluginId: available.pluginId });
    const master = findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined);
    expect(master.props.disabled).toBe(false);
    flip(master, false);
    await nextTick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(master.props.disabled).toBe(true);
    await mounted.setProps({ pendingPluginIds: [pending.pluginId, available.pluginId] });
    finish(available);
    await nextTick();
    await nextTick();
    expect(master.props.disabled).toBe(true);
    await mounted.setProps({ pendingPluginIds: [pending.pluginId] });
    expect(master.props.disabled).toBe(false);
  });

  it("retains the authorization dialog and its failure reason, locking all actions while saving", async () => {
    const fresh = plugin({ hasSavedGrant: false, grant: { ...plugin().grant, external: false } });
    let fail!: (error: Error) => void;
    const save = vi.fn(
      () =>
        new Promise<PluginMcpView>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { mounted } = mountCards([fresh], save, { selectedPluginId: fresh.pluginId });
    flip(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined),
      true,
    );
    await nextTick();
    const dialog = findOne(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined);
    dispatch(
      findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-confirm"] !== undefined),
      "click",
    );
    await nextTick();
    expect(findAll(dialog, (node) => node.type === "button").every((node) => node.props.disabled)).toBe(true);
    fail(new Error("permission denied"));
    await nextTick();
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined)).toHaveLength(1);
    expect(hostText(findOne(dialog, (node) => node.props["data-mcp-plugin-authorize-error"] !== undefined))).toContain("permission denied");
    expect(fresh.grant.external).toBe(false);
  });

  it("keeps pending authorization available in the selected view", async () => {
    const view = plugin({ tools: [tool("new_tool", "write", "pendingApproval")] });
    const { mounted, save } = mountCards([view], undefined, { selectedPluginId: view.pluginId });
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-review"] !== undefined),
      "click",
    );
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-authorize-tool"] === "new_tool")).toHaveLength(1);
  });

  it("shows distinct empty, filtered, and removed-plugin states", async () => {
    const view = plugin({ tools: [] });
    const { mounted, refresh } = mountCards([view], undefined, { selectedPluginId: view.pluginId });
    expect(hostText(mounted.root)).toContain("settings.mcpPluginNoTools");
    await mounted.setProps({ plugins: [plugin({ grant: { ...plugin().grant, external: false } })], onlyEnabled: true });
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginOnlyEnabledEmpty");
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-master"] !== undefined)).toHaveLength(1);
    await mounted.setProps({ plugins: [] });
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginUnavailable");
    const refreshButton = findOne(mounted.root, (node) => node.props["data-mcp-plugins-refresh"] !== undefined);
    dispatch(refreshButton, "click");
    expect(refresh).toHaveBeenCalledOnce();
    await mounted.setProps({ loading: true });
    expect(refreshButton.props.disabled).toBe(true);
    dispatch(refreshButton, "click");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains an expanded tool after filters, tool disable, and plugin disable (search dialog: %s)", async (listHidden) => {
    const view = plugin();
    const { mounted } = mountCards([view], undefined, { selectedPluginId: view.pluginId, listHidden });
    await mounted.exposed.value.openTool(view.pluginId, "list_dir");
    const disabledTools = { ...view, grant: { ...view.grant, disabledTools: ["list_dir", "upload"] } };
    await mounted.setProps({ plugins: [disabledTools], onlyEnabled: true });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-tool"] !== undefined).map((node) => node.props["data-mcp-plugin-tool"])).toEqual(["list_dir", "exec"]);
    expect(hostText(findOne(mounted.root, (node) => node.props["data-mcp-plugin-tool-detail"] !== undefined))).toContain("Absolute path");
    await mounted.setProps({ plugins: [{ ...disabledTools, grant: { ...disabledTools.grant, external: false } }] });
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-tool"] !== undefined).map((node) => node.props["data-mcp-plugin-tool"])).toEqual(["list_dir"]);
    const row = findOne(mounted.root, (node) => node.props["data-mcp-plugin-tool"] === "list_dir");
    expect(findOne(row, (node) => node.props["data-stub"] === "Switch").props.disabled).toBe(true);
    dispatch(
      findOne(row, (node) => node.props["data-mcp-plugin-tool-toggle"] !== undefined),
      "click",
    );
    await nextTick();
    expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-tool"] !== undefined)).toHaveLength(0);
  });

  it("opens a search tool directly while the list is hidden and restores trigger focus", async () => {
    const view = plugin();
    const { mounted } = mountCards([view], undefined, { selectedPluginId: view.pluginId, listHidden: true });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const focus = vi.spyOn(trigger, "focus");
    try {
      expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-detail"] !== undefined)).toHaveLength(0);
      await mounted.exposed.value.openTool(view.pluginId, "list_dir", trigger);
      expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-inline"] !== undefined)).toHaveLength(0);
      expect(findAll(mounted.root, (node) => node.props["data-mcp-plugin-open"] !== undefined)).toHaveLength(0);
      const detail = findOne(mounted.root, (node) => node.props["data-mcp-plugin-detail"] !== undefined);
      const expanded = findOne(detail, (node) => node.props["data-mcp-plugin-tool-detail"] !== undefined);
      expect(hostText(expanded)).toContain("Absolute path");
      const preventDefault = vi.fn();
      dispatch(detail, "closeAutoFocus", { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      trigger.remove();
    }
  });

  it("restores the search fallback when the detail trigger was removed", async () => {
    const view = plugin();
    const focusFallback = vi.fn();
    const { mounted } = mountCards([view], undefined, { listHidden: true, focusFallback });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    await mounted.exposed.value.openTool(view.pluginId, "list_dir", trigger);
    trigger.remove();
    const detail = findOne(mounted.root, (node) => node.props["data-mcp-plugin-detail"] !== undefined);
    const preventDefault = vi.fn();
    dispatch(detail, "closeAutoFocus", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focusFallback).toHaveBeenCalledOnce();
  });

  it("restores authorization trigger focus and falls back after the trigger disappears", async () => {
    const view = plugin({ tools: [tool("new_tool", "write", "pendingApproval")] });
    const focusFallback = vi.fn();
    const { mounted } = mountCards([view], undefined, { selectedPluginId: view.pluginId, focusFallback });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const focus = vi.spyOn(trigger, "focus");
    try {
      dispatch(
        findOne(mounted.root, (node) => node.props["data-mcp-plugin-review"] !== undefined),
        "click",
        { currentTarget: trigger },
      );
      await nextTick();
      const dialog = findOne(mounted.root, (node) => node.props["data-mcp-plugin-authorize"] !== undefined);
      const preventDefault = vi.fn();
      dispatch(dialog, "closeAutoFocus", { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(focusFallback).not.toHaveBeenCalled();
      trigger.remove();
      dispatch(dialog, "closeAutoFocus", { preventDefault });
      expect(focusFallback).toHaveBeenCalledOnce();
    } finally {
      trigger.remove();
    }
  });
});
