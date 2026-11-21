// @vitest-environment happy-dom

import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { McpAccessPolicy } from "@/types/mcpCatalog";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}` }),
}));
vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Loader2: icon, Plus: icon, X: icon };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Select: createPassthroughStub("Select", "div"),
    SelectContent: createPassthroughStub("SelectContent", "div"),
    SelectItem: createPassthroughStub("SelectItem", "div"),
    SelectTrigger: createPassthroughStub("SelectTrigger", "button"),
    SelectValue: createPassthroughStub("SelectValue", "span"),
  };
});

import McpPluginScopeEditor from "@/components/settings/McpPluginScopeEditor.vue";

const policy: McpAccessPolicy = {
  version: 2,
  defaultAccess: "write",
  rules: [
    { target: { kind: "connection", id: "k1" }, subScope: "selected" },
    { target: { kind: "scope", connectionId: "k1", scope: "namespace", value: "staging" }, visible: true, access: "read" },
    { target: { kind: "scope", connectionId: "k1", scope: "namespace", value: "dev" }, visible: true },
    { target: { kind: "scope", connectionId: "other", scope: "namespace", value: "x" }, visible: true },
  ],
};

function mountEditor(save = vi.fn(async () => policy)) {
  const saved = vi.fn();
  const mounted = mountComponent(McpPluginScopeEditor, { connectionId: "k1", kind: "namespace", title: "Namespace", policy, save, onSaved: saved });
  return { mounted, save, saved };
}

function selects(root: ReturnType<typeof mountComponent>["root"]) {
  return findAll(root, (node) => node.props["data-stub"] === "Select");
}

describe("McpPluginScopeEditor", () => {
  it("lists this connection's scope values sorted, with their levels", () => {
    const { mounted } = mountEditor();
    const values = findAll(mounted.root, (node) => node.props["data-mcp-plugin-scope-value"] !== undefined).map((node) => node.props["data-mcp-plugin-scope-value"]);
    expect(values).toEqual(["dev", "staging"]);
    expect(selects(mounted.root)[0].props["model-value"] ?? selects(mounted.root)[0].props.modelValue).toBe("selected");
    expect(hostText(mounted.root)).toContain('settings.mcpPluginScopeSelected {"count":2}');
  });

  it("adds a value as visible, changes levels, and removes values", async () => {
    const { mounted, save, saved } = mountEditor();
    const input = findOne(mounted.root, (node) => node.props["data-stub"] === "Input");
    (input.props["onUpdate:modelValue"] as (value: string) => void)("prod");
    await nextTick();
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-scope-add"] === "k1"),
      "click",
    );
    await nextTick();
    expect(save).toHaveBeenLastCalledWith("k1", "namespace", "prod", { visible: true }, null);
    await nextTick();
    expect(saved).toHaveBeenCalledWith(policy);

    (selects(mounted.root)[1].props["onUpdate:modelValue"] as (value: string) => void)("full");
    await nextTick();
    expect(save).toHaveBeenLastCalledWith("k1", "namespace", "dev", { visible: true, access: "full" }, null);
    // Controls are disabled while a save is in flight; let it settle first.
    await nextTick();
    await nextTick();

    const remove = findAll(mounted.root, (node) => node.type === "button" && node.props["aria-label"] === "settings.mcpToolCustomRemove")[0];
    dispatch(remove, "click");
    await nextTick();
    expect(save).toHaveBeenLastCalledWith("k1", "namespace", "dev", null, null);
  });

  it("switches the admission mode", async () => {
    const { mounted, save, saved } = mountEditor();
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginImmediate");
    (selects(mounted.root)[0].props["onUpdate:modelValue"] as (value: string) => void)("none");
    // Scope edits persist directly, without any settings-dialog Apply action.
    expect(save).toHaveBeenCalledWith("k1", "namespace", null, null, "none");
    await nextTick();
    await nextTick();
    expect(saved).toHaveBeenCalledWith(policy);
    mounted.unmount();
  });

  it("does not replace a saved read-only scope when the same name is added again", async () => {
    const { mounted, save } = mountEditor();
    const input = findOne(mounted.root, (node) => node.props["data-stub"] === "Input");
    (input.props["onUpdate:modelValue"] as (value: string) => void)(" staging ");
    await nextTick();
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-scope-add"] === "k1"),
      "click",
    );
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    const scope = findOne(mounted.root, (node) => node.props["data-mcp-plugin-scope-value"] === "staging");
    expect(selects(scope)[0].props["model-value"] ?? selects(scope)[0].props.modelValue).toBe("read");
    mounted.unmount();
  });

  it("retains a new scope after failure and clears it only after a successful retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("scope save failed")).mockResolvedValue(policy);
    const { mounted, saved } = mountEditor(save);
    const input = findOne(mounted.root, (node) => node.props["data-stub"] === "Input");
    (input.props["onUpdate:modelValue"] as (value: string) => void)("prod");
    await nextTick();
    const add = () =>
      dispatch(
        findOne(mounted.root, (node) => node.props["data-mcp-plugin-scope-add"] === "k1"),
        "click",
      );
    add();
    await vi.waitFor(() => expect(hostText(mounted.root)).toContain("scope save failed"));
    expect(input.props.modelValue).toBe("prod");
    expect(saved).not.toHaveBeenCalled();
    add();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(policy));
    await nextTick();
    expect(input.props.modelValue).toBe("");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("k1", "namespace", "prod", { visible: true }, null);
    mounted.unmount();
  });

  it("rejects a second scope mutation while the first save is pending", async () => {
    let finish!: (value: McpAccessPolicy) => void;
    const save = vi.fn(
      () =>
        new Promise<McpAccessPolicy>((resolve) => {
          finish = resolve;
        }),
    );
    const { mounted } = mountEditor(save);
    const mode = selects(mounted.root)[0].props["onUpdate:modelValue"] as (value: string) => void;
    mode("none");
    // A second event can arrive before Vue renders disabled controls.
    mode("all");
    expect(save).toHaveBeenCalledTimes(1);
    finish(policy);
    await nextTick();
    await nextTick();
    mounted.unmount();
  });

  it.each(["inherit", "full"])("preserves scope visibility and ceilings when changing access to %s", async (access) => {
    const restricted: McpAccessPolicy = {
      ...policy,
      rules: [policy.rules[0], { target: { kind: "scope", connectionId: "k1", scope: "namespace", value: "staging" }, visible: false, access: "read", ceiling: "read", toolsetCeilings: { admin: "none" } }],
    };
    const save = vi.fn(async () => restricted);
    const mounted = mountComponent(McpPluginScopeEditor, { connectionId: "k1", kind: "namespace", title: "Namespace", policy: restricted, save });
    (selects(mounted.root)[1].props["onUpdate:modelValue"] as (value: string) => void)(access);
    await nextTick();
    expect(save).toHaveBeenCalledExactlyOnceWith(
      "k1",
      "namespace",
      "staging",
      {
        visible: false,
        ceiling: "read",
        toolsetCeilings: { admin: "none" },
        ...(access === "full" ? { access: "full" } : {}),
      },
      null,
    );
    mounted.unmount();
  });

  it.each(["disabled", "loading"])("does not save while scope controls are %s", async (state) => {
    const save = vi.fn(async () => policy);
    const mounted = mountComponent(McpPluginScopeEditor, { connectionId: "k1", kind: "namespace", title: "Namespace", policy: state === "loading" ? null : policy, disabled: state === "disabled", save });
    (selects(mounted.root)[0].props["onUpdate:modelValue"] as (value: string) => void)("none");
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("keeps the saved scope and shows an error if an immediate save fails", async () => {
    const { mounted, save, saved } = mountEditor(
      vi.fn(async () => {
        throw new Error("scope save failed");
      }),
    );
    (selects(mounted.root)[0].props["onUpdate:modelValue"] as (value: string) => void)("none");
    expect(save).toHaveBeenCalledOnce();
    await nextTick();
    await nextTick();
    expect(saved).not.toHaveBeenCalled();
    expect(selects(mounted.root)[0].props["model-value"] ?? selects(mounted.root)[0].props.modelValue).toBe("selected");
    expect(hostText(mounted.root)).toContain("scope save failed");
    expect(hostText(mounted.root)).toContain("settings.mcpBrowser.pluginImmediate");
    mounted.unmount();
  });

  it("loads scope values from the plugin sidecar as selectable entries", async () => {
    const listValues = vi.fn(async () => ({ values: ["prod", "dev", "prod"] }));
    const mounted = mountComponent(McpPluginScopeEditor, {
      connectionId: "k1",
      pluginId: "plugin.demo",
      kind: "namespace",
      title: "Namespace",
      policy,
      save: vi.fn(async () => policy),
      listValues,
    });
    dispatch(
      findOne(mounted.root, (node) => node.props["data-mcp-plugin-scope-list"] !== undefined),
      "click",
    );
    await nextTick();
    await nextTick();
    expect(listValues).toHaveBeenCalledWith("plugin.demo", "k1");
    expect(hostText(mounted.root)).toContain("prod");
    expect(hostText(mounted.root)).toContain("dev");
  });
});
