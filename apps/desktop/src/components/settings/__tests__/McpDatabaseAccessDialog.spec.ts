// @vitest-environment happy-dom
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { ConnectionConfig } from "@/types/database";
import { databaseAccess, type McpDatabaseAccess } from "@/lib/mcp/mcpDatabaseAccess";
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const known: Record<string, string> = { "settings.mcpToolset.sqlSchema.title": "对象结构", "settings.mcpToolset.sqlSchema.description": "浏览表、字段和存储过程源码。" };
      return `${known[key] ?? key}${values ? ` ${JSON.stringify(values)}` : ""}`;
    },
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { AlertTriangle: icon, ChevronDown: icon, ChevronRight: icon, Loader2: icon, Minus: icon, Search: icon };
});

vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/tooltip", async () => ({ HelpTooltip: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("HelpTooltip", "button") }));
vi.mock("@/components/ui/switch", async () => ({ Switch: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Switch", "button") }));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    // Render the dialog body only while open, like the real portal.
    Dialog: defineComponent({
      name: "Dialog",
      props: { open: Boolean },
      emits: ["update:open"],
      setup(props, { slots, emit }) {
        return () => (props.open ? h("div", { "data-stub": "Dialog" }, [...(slots.default?.() ?? []), h("button", { "data-dialog-dismiss": "", onClick: () => emit("update:open", false) })]) : null);
      },
    }),
    DialogContent: createPassthroughStub("DialogContent", "div"),
    DialogDescription: createPassthroughStub("DialogDescription", "p"),
    DialogHeader: createPassthroughStub("DialogHeader", "div"),
    DialogTitle: createPassthroughStub("DialogTitle", "h2"),
  };
});

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

import McpDatabaseAccessDialog from "../McpDatabaseAccessDialog.vue";
const selected = (names: string[]): McpDatabaseAccess => ({ databaseScope: "selected", allowedDatabases: names, databasePolicies: [] });
function mountDialog(extra: Record<string, unknown> = {}) {
  const changes = vi.fn((value: McpDatabaseAccess) => {
    void mounted.setProps({ value });
  });
  const mounted = mountComponent(McpDatabaseAccessDialog, {
    open: true,
    connection: { id: "c1", name: "Local", db_type: "mysql" } as ConnectionConfig,
    value: selected([]),
    savedValue: databaseAccess(),
    inheritedLabel: "Read only · Group",
    savedInheritedLabel: "Read only · Group",
    savedVisible: true,
    loadDatabases: vi.fn(async () => ["aaa", "abc", "ops"]),
    save: vi.fn(async () => {}),
    onChange: changes,
    "onUpdate:open": (open: boolean) => {
      void mounted.setProps({ open });
    },
    ...extra,
  });
  const get = (attr: string, value: string | undefined = undefined) => findOne(mounted.root, (node) => (value === undefined ? node.props[attr] !== undefined : node.props[attr] === value));
  const click = async (attr: string) => {
    dispatch(get(attr), "click");
    await nextTick();
  };
  const check = async (name: string, checked = true) => {
    dispatch(get("data-mcp-database-check", name), "change", { target: { checked } });
    await nextTick();
  };
  const search = async (side: string, text: string) => {
    get("data-mcp-database-search", side).props["onUpdate:modelValue"](text);
    await nextTick();
  };
  const select = (attr: string, value: string | undefined = undefined) => findAll(mounted.root, (node) => node.props["data-stub"] === "Select").find((node) => findAll(node, (child) => (value === undefined ? child.props[attr] !== undefined : child.props[attr] === value)).length)!;
  const choose = async (attr: string, value: string | undefined, setting: string) => {
    select(attr, value).props["onUpdate:modelValue"](setting);
    await nextTick();
  };
  return { mounted, changes, get, click, check, search, choose, select };
}
const settle = async () => {
  await nextTick();
  await nextTick();
};

describe("database access transfer dialog", () => {
  it("selects databases, inherits permissions, overrides one, and restores inheritance", async () => {
    const h = mountDialog();
    await settle();
    await h.check("left:aaa");
    await h.check("left:abc");
    await h.click("data-mcp-database-add");
    expect(h.changes).toHaveBeenLastCalledWith(selected(["aaa", "abc"]));
    expect(hostText(h.mounted.root)).toContain("Read only · Group");
    await h.choose("data-mcp-database-level", "abc", "safe_write");
    expect(h.changes.mock.lastCall![0].databasePolicies).toEqual([{ databaseName: "abc", readOnly: false, allowDangerousSql: false }]);
    await h.choose("data-mcp-database-level", "abc", "inherit");
    expect(h.changes.mock.lastCall![0].databasePolicies).toEqual([]);
    await h.mounted.setProps({ inheritedLabel: "Full access · Connection" });
    expect(hostText(h.get("data-mcp-database-parent-draft"))).toContain("Read only · Group");
    expect(h.get("data-mcp-database-level", "abc").props["aria-description"]).toContain("Full access · Connection");
    h.mounted.unmount();
  });
  it("confirms removal of overrides, supports cancelling, and removing the last database denies access", async () => {
    const h = mountDialog({ value: { ...selected(["aaa"]), databasePolicies: [{ databaseName: "aaa", readOnly: true, allowDangerousSql: false }] } });
    await settle();
    await h.check("right:aaa");
    await h.click("data-mcp-database-remove");
    expect(h.changes).not.toHaveBeenCalled();
    await h.click("data-mcp-database-confirm-cancel");
    await h.check("right:aaa");
    await h.click("data-mcp-database-remove");
    await h.click("data-mcp-database-confirm");
    expect(h.changes).toHaveBeenLastCalledWith(selected([]));
    expect(hostText(h.mounted.root)).toContain("settings.mcpDatabaseNoneHint");
    h.mounted.unmount();
  });
  it("confirms full access and clears overrides only after confirming an all-databases scope", async () => {
    const h = mountDialog({ value: selected(["aaa"]) });
    await settle();
    await h.choose("data-mcp-database-level", "aaa", "high_risk_write");
    expect(h.changes).not.toHaveBeenCalled();
    await h.click("data-mcp-database-confirm");
    expect(h.changes.mock.lastCall![0].databasePolicies[0].allowDangerousSql).toBe(true);
    await h.choose("data-mcp-database-mode", undefined, "all");
    await h.click("data-mcp-database-confirm");
    expect(h.changes).toHaveBeenLastCalledWith(databaseAccess());
    expect(hostText(h.mounted.root)).toContain("settings.mcpDatabaseAllHint");
    h.mounted.unmount();
  });
  it("searches the entire discovered list beyond the render limit and adds every matching result", async () => {
    const names = Array.from({ length: 260 }, (_, i) => `db_${String(i).padStart(3, "0")}`);
    const load = vi.fn(async () => names);
    const h = mountDialog({ loadDatabases: load });
    await settle();
    expect(findAll(h.get("data-mcp-database-pane", "left"), (n) => n.props["data-mcp-database-name"] !== undefined)).toHaveLength(100);
    await h.click("data-mcp-database-more");
    expect(findAll(h.get("data-mcp-database-pane", "left"), (n) => n.props["data-mcp-database-name"] !== undefined)).toHaveLength(200);
    await h.search("left", "db_25");
    dispatch(h.get("data-mcp-database-check-results", "left"), "change", { target: { checked: true } });
    await nextTick();
    await h.click("data-mcp-database-add");
    expect(h.changes.mock.lastCall![0].allowedDatabases).toEqual(names.slice(250));
    await h.search("left", "");
    dispatch(h.get("data-mcp-database-check-results", "left"), "change", { target: { checked: true } });
    await nextTick();
    await h.click("data-mcp-database-add");
    expect(h.changes.mock.lastCall![0].allowedDatabases).toEqual(names);
    expect(h.changes.mock.lastCall![0].databaseScope).toBe("selected");
    expect(load).toHaveBeenCalledOnce();
    h.mounted.unmount();
  });
  it("retries failed discovery, preserves configured names and allows manual addition", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(["aaa", "aaa", "abc"]);
    const h = mountDialog({ value: selected(["missing"]), loadDatabases: load });
    await settle();
    expect(hostText(h.mounted.root)).toContain("offline");
    expect(hostText(h.get("data-mcp-database-pane", "right"))).toContain("missing");
    h.get("data-mcp-database-manual").props["onUpdate:modelValue"]("new_db");
    await nextTick();
    await h.click("data-mcp-database-manual-add");
    await h.click("data-mcp-database-refresh");
    await settle();
    expect(h.changes.mock.lastCall![0].allowedDatabases).toEqual(["missing", "new_db"]);
    expect(h.get("data-mcp-database-level", "missing").props["aria-description"]).toContain("settings.mcpDatabaseNotDiscovered");
    expect(findAll(h.get("data-mcp-database-pane", "left"), (n) => n.props["data-mcp-database-name"] !== undefined)).toHaveLength(2);
    h.mounted.unmount();
  });
  it("sets permissions only for checked databases, restores inheritance, and keeps individual editing", async () => {
    const save = vi.fn();
    const initial = { ...selected(["aaa", "abc", "ops"]), databasePolicies: [{ databaseName: "ops", readOnly: true, allowDangerousSql: false }] };
    const h = mountDialog({ value: initial, savedValue: initial, save });
    await settle();
    expect(h.select("data-mcp-database-batch-level").props.disabled).toBe(true);
    await h.choose("data-mcp-database-batch-level", undefined, "safe_write");
    expect(h.changes).not.toHaveBeenCalled();
    await h.check("right:aaa");
    await h.check("right:abc");
    expect(h.get("data-mcp-database-batch-level").props["aria-label"]).toContain('"count":2');
    for (const setting of ["read_only", "safe_write", "inherit"]) {
      await h.choose("data-mcp-database-batch-level", undefined, setting);
      expect(h.changes.mock.lastCall![0]).toEqual({
        ...initial,
        databasePolicies: [...(setting === "inherit" ? [] : ["aaa", "abc"].map((databaseName) => ({ databaseName, readOnly: setting === "read_only", allowDangerousSql: false }))), ...initial.databasePolicies],
      });
    }
    await h.choose("data-mcp-database-level", "abc", "read_only");
    expect(h.changes.mock.lastCall![0].databasePolicies).toEqual([{ databaseName: "abc", readOnly: true, allowDangerousSql: false }, ...initial.databasePolicies]);
    await h.choose("data-mcp-database-batch-level", undefined, "inherit");
    expect(h.changes.mock.lastCall![0]).toEqual(initial);
    expect(save).not.toHaveBeenCalled();
    h.mounted.unmount();
  });
  it("confirms a batch of full-access changes once and can cancel it", async () => {
    const h = mountDialog({ value: selected(["aaa", "abc", "ops"]) });
    await settle();
    await h.check("right:aaa");
    await h.check("right:abc");
    await h.choose("data-mcp-database-batch-level", undefined, "high_risk_write");
    expect(h.changes).not.toHaveBeenCalled();
    expect(hostText(h.mounted.root)).toContain('settings.mcpDatabaseBatchHighRiskConfirm {"count":2}');
    expect(h.select("data-mcp-database-batch-level").props.disabled).toBe(true);
    await h.choose("data-mcp-database-batch-level", undefined, "read_only");
    await h.choose("data-mcp-database-level", "ops", "safe_write");
    expect(h.changes).not.toHaveBeenCalled();
    await h.click("data-mcp-database-confirm-cancel");
    expect(h.changes).not.toHaveBeenCalled();
    await h.choose("data-mcp-database-batch-level", undefined, "high_risk_write");
    await h.click("data-mcp-database-confirm");
    expect(h.changes).toHaveBeenCalledOnce();
    expect(h.changes.mock.lastCall![0]).toEqual({ ...selected(["aaa", "abc", "ops"]), databasePolicies: ["aaa", "abc"].map((databaseName) => ({ databaseName, readOnly: false, allowDangerousSql: true })) });
    await h.choose("data-mcp-database-batch-level", undefined, "high_risk_write");
    expect(h.changes).toHaveBeenCalledOnce();
    expect(findAll(h.mounted.root, (node) => node.props["data-mcp-database-confirm"] !== undefined)).toHaveLength(0);
    h.mounted.unmount();
  });
  it("updates every checked search result beyond the render limit and clears checks when searching", async () => {
    const names = Array.from({ length: 260 }, (_, i) => `db_${String(i).padStart(3, "0")}`);
    const h = mountDialog({ value: selected([...names, "other"]), loadDatabases: async () => [...names, "other"] });
    await settle();
    await h.search("right", "db_");
    dispatch(h.get("data-mcp-database-check-results", "right"), "change", { target: { checked: true } });
    await nextTick();
    expect(findAll(h.get("data-mcp-database-pane", "right"), (n) => n.props["data-mcp-database-name"] !== undefined)).toHaveLength(100);
    expect(h.get("data-mcp-database-batch-level").props["aria-label"]).toContain('"count":260');
    await h.choose("data-mcp-database-batch-level", undefined, "read_only");
    expect(h.changes.mock.lastCall![0]).toEqual({ ...selected([...names, "other"]), databasePolicies: names.map((databaseName) => ({ databaseName, readOnly: true, allowDangerousSql: false })) });
    await h.search("right", "other");
    expect(h.select("data-mcp-database-batch-level").props.disabled).toBe(true);
    await h.choose("data-mcp-database-batch-level", undefined, "safe_write");
    expect(h.changes).toHaveBeenCalledOnce();
    h.mounted.unmount();
  });
  it("ignores stale checks after a database is removed and disables batch edits when locked", async () => {
    const h = mountDialog({ value: selected(["aaa", "abc"]) });
    await settle();
    await h.check("right:aaa");
    await h.check("right:abc");
    await h.mounted.setProps({ value: selected(["abc"]) });
    expect(h.get("data-mcp-database-batch-level").props["aria-label"]).toContain('"count":1');
    await h.mounted.setProps({ disabled: true });
    expect(h.select("data-mcp-database-batch-level").props.disabled).toBe(true);
    await h.choose("data-mcp-database-batch-level", undefined, "read_only");
    expect(h.changes).not.toHaveBeenCalled();
    await h.mounted.setProps({ disabled: false });
    await h.choose("data-mcp-database-batch-level", undefined, "read_only");
    expect(h.changes).toHaveBeenLastCalledWith({ ...selected(["abc"]), databasePolicies: [{ databaseName: "abc", readOnly: true, allowDangerousSql: false }] });
    h.mounted.unmount();
  });
  it("preserves searches, checked databases and pending confirmation when connection metadata refreshes", async () => {
    const load = vi.fn(async () => ["aaa", "abc", "ops"]);
    const h = mountDialog({ value: selected(["aaa", "abc", "ops"]), loadDatabases: load });
    await settle();
    await h.search("right", "a");
    await h.check("right:aaa");
    await h.check("right:abc");
    await h.choose("data-mcp-database-batch-level", undefined, "high_risk_write");
    await h.mounted.setProps({ connection: { id: "c1", name: "Updated Local", db_type: "mysql" } });
    await settle();
    expect(h.get("data-mcp-database-search", "right").props["model-value"]).toBe("a");
    expect(h.get("data-mcp-database-check", "right:aaa").props.checked).toBe(true);
    expect(h.get("data-mcp-database-check", "right:abc").props.checked).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    await h.click("data-mcp-database-confirm");
    expect(h.changes.mock.lastCall![0].databasePolicies).toHaveLength(2);
    h.mounted.unmount();
  });
  it("ignores an old discovery after closing and reopening", async () => {
    let resolveOld!: (names: string[]) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(["fresh"]);
    const h = mountDialog({ loadDatabases: load });
    await settle();
    await h.click("data-mcp-database-close");
    await h.mounted.setProps({ open: true });
    await settle();
    resolveOld(["stale"]);
    await settle();
    expect(hostText(h.mounted.root)).toContain("fresh");
    expect(hostText(h.mounted.root)).not.toContain("stale");
    h.mounted.unmount();
  });
  it("retains the draft on save failure, retries successfully and stays open", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async () => {
        await h.mounted.setProps({ savedValue: selected(["aaa"]) });
      });
    const h = mountDialog({ value: selected(["aaa"]), save });
    await settle();
    await h.click("data-mcp-database-apply");
    await settle();
    expect(hostText(h.mounted.root)).toContain("disk full");
    expect(h.get("data-mcp-database-apply").props.disabled).toBe(false);
    expect(h.changes).not.toHaveBeenCalled();
    await h.click("data-mcp-database-apply");
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("c1");
    expect(h.get("data-mcp-database-apply").props.disabled).toBe(true);
    expect(hostText(h.mounted.root)).toContain("settings.mcpToolsetApplied");
    expect(hostText(h.mounted.root)).not.toContain("disk full");
    h.mounted.unmount();
  });
  it.each(["data-mcp-database-close", "data-dialog-dismiss"])("keeps selections and overrides when closing with %s", async (button) => {
    const save = vi.fn();
    const h = mountDialog({ save });
    await settle();
    await h.check("left:aaa");
    await h.click("data-mcp-database-add");
    await h.choose("data-mcp-database-level", "aaa", "read_only");
    await h.click(button);
    await h.mounted.setProps({ open: true });
    await settle();
    expect(hostText(h.get("data-mcp-database-pane", "right"))).toContain("aaa");
    expect(h.changes.mock.lastCall![0].databasePolicies[0].readOnly).toBe(true);
    expect(save).not.toHaveBeenCalled();
    h.mounted.unmount();
  });
  it("locks changes and dismissal while saving and prevents duplicate submissions", async () => {
    let finish!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const h = mountDialog({ value: selected(["aaa"]), save });
    await settle();
    await h.check("right:aaa");
    await h.click("data-mcp-database-apply");
    expect(h.get("data-mcp-database-close").props.disabled).toBe(true);
    expect(h.select("data-mcp-database-batch-level").props.disabled).toBe(true);
    await h.choose("data-mcp-database-batch-level", undefined, "safe_write");
    const event = new Event("keydown", { cancelable: true });
    h.get("data-mcp-database-dialog").props.onEscapeKeyDown(event);
    expect(event.defaultPrevented).toBe(true);
    await h.click("data-dialog-dismiss");
    expect(h.get("data-mcp-database-dialog")).toBeDefined();
    await h.choose("data-mcp-database-level", "aaa", "read_only");
    expect(h.changes).not.toHaveBeenCalled();
    await h.click("data-mcp-database-apply");
    expect(save).toHaveBeenCalledOnce();
    finish();
    await settle();
    h.mounted.unmount();
  });
});

it("restores the selected draft after an accidental all or none toggle", async () => {
  const h = mountDialog({ value: selected(["aaa", "ops"]) });
  await settle();
  for (const scope of ["all", "none"]) {
    await h.choose("data-mcp-database-mode", undefined, scope);
    expect(h.changes.mock.lastCall![0].allowedDatabases).toEqual([]);
    await h.choose("data-mcp-database-mode", undefined, "selected");
    expect(h.changes).toHaveBeenLastCalledWith(selected(["aaa", "ops"]));
  }
  h.mounted.unmount();
});
