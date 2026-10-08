// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import SchedulerTaskFormRenderer from "../SchedulerTaskFormRenderer.vue";
import type { ConnectionConfig, PluginFormField } from "@/types/database";

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
      expect(document.body.querySelector("[data-scheduler-path-picker]")).not.toBeNull();

      document.body.querySelector<HTMLElement>('[data-scheduler-path-picker-entry="/sub"]')!.click();
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-choose]")!.click();
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
      expect(document.body.querySelector("[data-scheduler-path-picker]")).toBeNull();
    });
  });
});
