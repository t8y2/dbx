// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import SchedulerTaskFormRenderer from "../SchedulerTaskFormRenderer.vue";
import type { PluginFormField } from "@/types/database";

const mountedApps: App[] = [];

async function mountRenderer(fields: PluginFormField[], initial: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerTaskFormRenderer, { fields, modelValue: initial, "onUpdate:modelValue": (value: Record<string, unknown>) => Object.assign(initial, value) });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return { container, values: initial };
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
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
});
