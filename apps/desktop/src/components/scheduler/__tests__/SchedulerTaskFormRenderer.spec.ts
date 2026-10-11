// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import SchedulerTaskFormRenderer from "../SchedulerTaskFormRenderer.vue";
import type { ConnectionConfig, PluginFormField, PluginFormFieldGroup } from "@/types/database";

const mocks = vi.hoisted(() => ({
  invokePlugin: vi.fn(),
  invokePluginPathBrowse: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePlugin: mocks.invokePlugin,
  invokePluginPathBrowse: mocks.invokePluginPathBrowse,
}));

const mountedApps: App[] = [];

async function mountRenderer(fields: PluginFormField[], initial: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerTaskFormRenderer, { fields, modelValue: initial, "onUpdate:modelValue": (value: Record<string, unknown>) => Object.assign(initial, value), ...extra });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return { container, values: initial };
}

/** mountRenderer + a groups prop, typed for the group-rendering suite. */
async function mountGroupedRenderer(fields: PluginFormField[], groups: PluginFormFieldGroup[], initial: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return mountRenderer(fields, initial, { ...extra, groups });
}

async function openSelect(trigger: HTMLElement) {
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function selectOptionLabels(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent?.trim() ?? "");
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const fields: PluginFormField[] = [
  { key: "command", label: "Command", type: "textarea", required: true, placeholder: "uptime" },
  {
    key: "mode",
    label: "Mode",
    type: "select",
    options: [
      { label: "Fast", value: "fast" },
      { label: "Safe", value: "safe" },
    ],
    default: "safe",
  },
  { key: "extra", label: "Extra args", type: "text", visible_when: { field: "mode", one_of: ["safe"] } },
  { key: "pty", label: "Allocate PTY", type: "boolean" },
  { key: "token", label: "Token", type: "password", binding: "secret" },
];

function exposedPersistedConfig(): Record<string, unknown> {
  const app = mountedApps[mountedApps.length - 1]!;
  return (app._instance!.exposed as { persistedConfig: { value: Record<string, unknown> } }).persistedConfig.value;
}

function labelTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "");
}

describe("SchedulerTaskFormRenderer", () => {
  it("renders manifest fields dynamically, honoring visible_when", async () => {
    const { container } = await mountRenderer(fields, {});
    const labels = labelTexts(container);
    expect(labels.some((text) => text.startsWith("Command"))).toBe(true);
    expect(labels.some((text) => text.startsWith("Extra args"))).toBe(true);
    expect(labels.some((text) => text.startsWith("Token"))).toBe(true);
  });

  it("hides conditional fields when the controller value does not match", async () => {
    const { container } = await mountRenderer(fields, { mode: "fast" });
    const labels = labelTexts(container);
    expect(labels.some((text) => text.startsWith("Command"))).toBe(true);
    expect(labels.some((text) => text.startsWith("Extra args"))).toBe(false);
  });

  it("marks required fields and emits updates into the model", async () => {
    const values: Record<string, unknown> = {};
    const { container } = await mountRenderer(fields, values);
    expect(container.querySelector("label .text-destructive")).toBeTruthy();
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    textarea!.value = "systemctl is-active nginx";
    textarea!.dispatchEvent(new Event("input"));
    await nextTick();
    expect(values.command).toBe("systemctl is-active nginx");
  });

  it("never exposes secret-bound values through the persisted config projection", async () => {
    await mountRenderer(fields, { command: "uptime", token: "super-secret-value" });
    const persisted = exposedPersistedConfig();
    // Visible non-secret values persist, including declared defaults.
    expect(persisted).toEqual({ command: "uptime", mode: "safe" });
    expect(JSON.stringify(persisted)).not.toContain("super-secret-value");
  });

  describe("options_action (host-reserved namespace)", () => {
    const connections = [
      { id: "conn-1", name: "Production DB" },
      { id: "conn-2", name: "Staging" },
    ] as ConnectionConfig[];

    const connectionField: PluginFormField = {
      key: "source_connection_id",
      label: "Source connection id",
      type: "text",
      binding: "config",
      options_action: "host/connections",
      placeholder: "(task connection)",
    };

    it("renders a select from host/connections and keeps an empty option labeled by the placeholder", async () => {
      const { container } = await mountRenderer([connectionField], {}, { connections });
      const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
      expect(trigger).not.toBeNull();
      expect(container.querySelector("input")).toBeNull();

      await openSelect(trigger!);
      const labels = selectOptionLabels();
      // Optional field: the empty entry (labeled by the field's own
      // placeholder) leads, then the host-resolved connection names.
      expect(labels[0]).toBe("(task connection)");
      expect(labels).toContain("Production DB");
      expect(labels).toContain("Staging");
    });

    it("labels the empty option from the declared empty_label, falling back to placeholder and the host default", async () => {
      // Declared empty_label wins over the placeholder.
      const { container } = await mountRenderer([{ ...connectionField, empty_label: "(follow task connection)" }], {}, { connections });
      await openSelect(container.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
      expect(selectOptionLabels()[0]).toBe("(follow task connection)");

      // No empty_label → the placeholder keeps naming the semantics.
      const { container: container2 } = await mountRenderer([connectionField], {}, { connections });
      await openSelect(container2.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
      expect(selectOptionLabels()[0]).toBe("(task connection)");

      // Neither → the host's own default wording (scheduler.editor.emptyOption).
      const { container: container3 } = await mountRenderer([{ ...connectionField, placeholder: undefined }], {}, { connections });
      await openSelect(container3.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
      expect(selectOptionLabels()[0]).toBe("(not set — follow the default)");
    });

    it("falls back to the declared text input when the host namespace resolves to no options", async () => {
      const { container } = await mountRenderer([{ ...connectionField, options_action: "host/unknown" }], {}, { connections });
      expect(container.querySelector('button[role="combobox"]')).toBeNull();
      expect(container.querySelector("input#scheduler-field-source_connection_id")).not.toBeNull();
    });

    it("keeps a stored value visible when its connection is missing from the options", async () => {
      const { container } = await mountRenderer([connectionField], { source_connection_id: "conn-gone" }, { connections });
      const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
      expect(trigger).not.toBeNull();
      expect(trigger?.textContent).toContain("conn-gone");

      await openSelect(trigger!);
      expect(selectOptionLabels()).toContain("conn-gone");
    });

    it("keeps the declared text input when no options_action is declared", async () => {
      const { container } = await mountRenderer([{ key: "source_connection_id", label: "Source connection id", type: "text", binding: "config", placeholder: "(task connection)" }], {}, { connections });
      expect(container.querySelector('button[role="combobox"]')).toBeNull();
      expect(container.querySelector("input#scheduler-field-source_connection_id")).not.toBeNull();
    });
  });

  describe("plugin directory picker (picker.source plugin)", () => {
    const pickerFields: PluginFormField[] = [
      {
        key: "source_path",
        label: "Source path",
        type: "text",
        binding: "config",
        picker: { kind: "directory", source: "plugin", action: "files/listDirs", connection_field: "source_connection_id" },
      },
      { key: "source_connection_id", label: "Source connection id", type: "text", binding: "config", placeholder: "(task connection)" },
    ];

    function dirsResult(entries: Array<[name: string, path: string]>) {
      return { entries: entries.map(([name, path]) => ({ name, path, is_dir: true })) };
    }

    async function clickBrowseButton(container: HTMLElement) {
      container.querySelector<HTMLButtonElement>("[data-scheduler-picker-plugin]")!.click();
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    }

    it("opens the dialog over the resolved sibling connection and backfills the picked path", async () => {
      mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/sub"]]));
      const { container, values } = await mountRenderer(pickerFields, { source_connection_id: "conn-src" }, { pluginId: "io.dbx.files" });
      await clickBrowseButton(container);
      // The dialog normalizes an empty stored path to the connection root.
      expect(mocks.invokePluginPathBrowse).toHaveBeenCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/", "en");
      expect(document.body.querySelector("[data-plugin-path-picker]")).not.toBeNull();

      document.body.querySelector<HTMLElement>('[data-plugin-path-picker-entry="/sub"]')!.click();
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      document.body.querySelector<HTMLElement>("[data-plugin-path-picker-choose]")!.click();
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(values.source_path).toBe("/sub");
    });

    it("falls back to the task connection when the sibling chain is empty, and prefers the sibling when set", async () => {
      mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
      const { container } = await mountRenderer(pickerFields, {}, { pluginId: "io.dbx.files", taskConnectionId: "conn-task" });
      await clickBrowseButton(container);
      expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-task", "/", "en");
    });

    it("keeps the browse button disabled with a hint while no connection is available", async () => {
      const { container } = await mountRenderer(pickerFields, {}, { pluginId: "io.dbx.files" });
      const button = container.querySelector<HTMLButtonElement>("[data-scheduler-picker-plugin]");
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(true);
      expect(container.querySelector("[data-scheduler-picker-needs-connection]")).not.toBeNull();
    });

    it("leaves the local native picker branch untouched for pickers without source", async () => {
      const { container } = await mountRenderer([{ key: "key_path", label: "Key path", type: "text", picker: { kind: "file" } }], {});
      const button = container.querySelector<HTMLButtonElement>("button");
      expect(button).not.toBeNull();
      expect(button!.dataset.schedulerPickerPlugin).toBeUndefined();
      button!.click();
      await nextTick();
      expect(document.body.querySelector("[data-plugin-path-picker]")).toBeNull();
    });
  });

  describe("static + dynamic option merge (options_action with declared options)", () => {
    const localField: PluginFormField = {
      key: "source_connection_id",
      label: "Source connection id",
      type: "text",
      binding: "config",
      options_action: "host/connections",
      empty_label: "(follow task connection)",
      options: [{ value: "local", label: "Local path" }],
    };

    const connections = [{ id: "conn-1", name: "Production DB" }] as ConnectionConfig[];

    it("renders static options ahead of the fetched ones, deduped by value", async () => {
      const { container } = await mountRenderer([localField], {}, { connections });
      const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
      expect(trigger).not.toBeNull();
      await openSelect(trigger!);
      const labels = selectOptionLabels();
      // Optional field: the empty entry leads; the declared static option
      // precedes the host-resolved connections.
      expect(labels[0]).toBe("(follow task connection)");
      expect(labels.indexOf("Local path")).toBeGreaterThan(-1);
      expect(labels.indexOf("Local path")).toBeLessThan(labels.indexOf("Production DB"));
      expect(labels.filter((label) => label === "Local path")).toHaveLength(1);
    });

    it("still renders the static options when the dynamic fetch fails or resolves empty", async () => {
      // host/unknown resolves to no host options — the declared static
      // options keep the select alive instead of degrading to a text input.
      const { container } = await mountRenderer([{ ...localField, options_action: "host/unknown" }], {}, { connections });
      expect(container.querySelector('button[role="combobox"]')).not.toBeNull();
      await openSelect(container.querySelector<HTMLButtonElement>('button[role="combobox"]')!);
      expect(selectOptionLabels()).toContain("Local path");
    });

    it("keeps the text-input fallback when neither static nor dynamic options exist", async () => {
      const { container } = await mountRenderer([{ ...localField, options: undefined }], {}, { connections: [] });
      expect(container.querySelector('button[role="combobox"]')).toBeNull();
      expect(container.querySelector("input#scheduler-field-source_connection_id")).not.toBeNull();
    });

    it("selecting the static option stores its value", async () => {
      const values: Record<string, unknown> = {};
      const { container } = await mountRenderer([localField], values, { connections: [] });
      // No connections saved: the select still offers the reserved local value.
      const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      const localOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.trim() === "Local path");
      expect(localOption).toBeTruthy();
      localOption!.focus();
      localOption!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(values.source_connection_id).toBe("local");
    });
  });

  describe("form field groups (trigger groups)", () => {
    const groupFields: PluginFormField[] = [
      {
        key: "mode",
        label: "What to copy",
        type: "select",
        options: [
          { label: "File", value: "file" },
          { label: "Directory", value: "directory" },
        ],
        default: "directory",
      },
      { key: "source_connection_id", label: "Source connection", type: "text", group: "source" },
      { key: "source_path", label: "Source path", type: "text", group: "source" },
      { key: "destination_connection_id", label: "Destination connection", type: "text", group: "target" },
      { key: "destination_path", label: "Destination path", type: "text", group: "target" },
      { key: "recursive", label: "Recursive", type: "boolean", group: "source", visible_when: { field: "mode", one_of: ["directory"] } },
      { key: "dry_run", label: "Dry run", type: "boolean" },
    ];
    const groups: PluginFormFieldGroup[] = [
      { id: "source", label: "Source" },
      { id: "target", label: "Target" },
    ];

    it("renders ungrouped fields in a leading plain section, then declared groups in order", async () => {
      const { container } = await mountGroupedRenderer(groupFields, groups, {});
      const sections = [...container.querySelectorAll("section")];
      expect(sections).toHaveLength(2);
      const sectionTitles = sections.map((section) => section.querySelector("div")?.textContent?.trim());
      expect(sectionTitles).toEqual(["Source", "Target"]);
      // Plain fields (mode, dry_run) live outside every section.
      const outside = [...container.querySelectorAll(":scope > div > div, :scope > div")].filter((node) => node.closest("section") === null);
      const outsideLabels = outside.flatMap((node) => [...node.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "")).filter(Boolean);
      expect(outsideLabels.some((label) => label.startsWith("What to copy"))).toBe(true);
      expect(outsideLabels.some((label) => label.startsWith("Dry run"))).toBe(true);
      // Group membership: source fields inside the first section, in
      // declaration order; target fields in the second.
      const sourceLabels = [...sections[0]!.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "");
      expect(sourceLabels.map((label) => label.split("*")[0])).toEqual(["Source connection", "Source path", "Recursive"]);
      const targetLabels = [...sections[1]!.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? "");
      expect(targetLabels.map((label) => label.split("*")[0])).toEqual(["Destination connection", "Destination path"]);
    });

    it("marks the flow between group sections with an arrow separator", async () => {
      const { container } = await mountGroupedRenderer(groupFields, groups, {});
      // The separator rides between the two sections (outside them), a
      // decorative right-arrow inside an aria-hidden wrapper.
      expect(container.querySelector('div[aria-hidden="true"] svg')).not.toBeNull();
      // No groups declared → no separator, flat rendering (pre-group shape).
      const { container: flat } = await mountRenderer(groupFields, {});
      expect(flat.querySelector("section")).toBeNull();
      expect(labelTexts(flat)).toHaveLength(groupFields.length);
    });

    it("hides a whole group section when visible_when hides every member", async () => {
      const { container } = await mountGroupedRenderer(groupFields, groups, { mode: "file" });
      const sections = [...container.querySelectorAll("section")];
      // `recursive` was the only field still visible in the source group's
      // tail; with mode=file the source section keeps its two unconditioned
      // fields, so assert the conditional one is gone instead.
      const labels = sections.flatMap((section) => [...section.querySelectorAll("label")].map((label) => label.textContent?.trim() ?? ""));
      expect(labels.some((label) => label.startsWith("Recursive"))).toBe(false);

      // A group whose every member is hidden does not render at all.
      const onlyConditional = [{ key: "extra", label: "Extra", type: "text", group: "source", visible_when: { field: "mode", one_of: ["file"] } }] satisfies PluginFormField[];
      const { container: container2 } = await mountGroupedRenderer(onlyConditional, groups, { mode: "directory" });
      expect(container2.querySelectorAll("section")).toHaveLength(0);
      expect(container2.textContent).not.toContain("Extra");
    });

    it("keeps every field rendered when a defensively-unknown group id slips through", async () => {
      const stray: PluginFormField[] = [{ key: "p", label: "Stray path", type: "text", group: "nowhere" }];
      const { container } = await mountGroupedRenderer(stray, groups, {});
      expect(container.querySelectorAll("section")).toHaveLength(0);
      expect(container.querySelector("input#scheduler-field-p")).not.toBeNull();
    });

    it("drops the heading of a group reduced to a single visible field", async () => {
      // A one-field group's title repeats what the field label already says
      // (feedback: 分组文案雷同) — the box stays, the heading goes, and no
      // flow divider introduces a heading-less section.
      const fields: PluginFormField[] = [
        { key: "note", label: "Note", type: "text" },
        { key: "lonely", label: "Lonely field", type: "text", group: "solo" },
      ];
      const { container } = await mountGroupedRenderer(fields, [{ id: "solo", label: "Lonely group" }], {});
      const section = container.querySelector("section");
      expect(section).not.toBeNull();
      expect(section!.textContent).not.toContain("Lonely group");
      expect(section!.querySelector("input#scheduler-field-lonely")).not.toBeNull();
      expect(container.querySelector('div[aria-hidden="true"] svg')).toBeNull();
    });
  });
});
