// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { AgentOfflineExportPreview } from "@/lib/backend/api";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogFooter: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      setup(props, { slots, emit }) {
        return () => h("button", { disabled: props.disabled, onClick: () => emit("click") }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      setup(_props, { slots }) {
        return () => h("span", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/scroll-area", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    ScrollArea: defineComponent({
      setup(_props, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/icons/DatabaseIcon.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      setup() {
        return () => h("span");
      },
    }),
  };
});

import AgentOfflineExportDialog from "@/components/config/AgentOfflineExportDialog.vue";

const mountedApps: App[] = [];

const preview: AgentOfflineExportPreview = {
  platform: "macos-aarch64",
  candidates: [
    {
      dbType: "duckdb",
      label: "DuckDB",
      version: "1.2.3",
      size: 1024,
      artifactKind: "jar",
      requiredJre: "21",
      eligible: true,
      unavailableReason: null,
    },
    {
      dbType: "kafka",
      label: "Apache Kafka",
      version: "4.0.0",
      size: 2048,
      artifactKind: "jar",
      requiredJre: "21",
      eligible: false,
      unavailableReason: "localInstall",
    },
    {
      dbType: "redis",
      label: "Redis",
      version: "8.0.0",
      size: 4096,
      artifactKind: "native",
      requiredJre: null,
      eligible: true,
      unavailableReason: null,
    },
  ],
};

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

async function mountDialog(props: Record<string, unknown>, onConfirm = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentOfflineExportDialog, { ...props, onConfirm });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return { onConfirm };
}

function buttonContaining(text: string) {
  return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

describe("AgentOfflineExportDialog", () => {
  it("selects eligible drivers by default and explains excluded candidates", async () => {
    i18n.global.locale.value = "en";
    const { onConfirm } = await mountDialog({ open: true, preview });

    expect(document.body.textContent).toContain("2 of 2 selected");
    expect(document.body.textContent).toContain("1 managed JRE(s) will be included automatically.");
    expect(document.body.textContent).toContain("Locally imported Agent builds are not included.");

    const inputs = [...document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.checked)).toEqual([true, false, true]);
    expect(inputs.map((input) => input.disabled)).toEqual([false, true, false]);
    expect(inputs[1]?.getAttribute("aria-describedby")).toBe("offline-export-reason-kafka");
    expect(document.getElementById("offline-export-reason-kafka")?.textContent).toContain("Locally imported");

    buttonContaining("Export 2 driver(s)")?.click();
    expect(onConfirm).toHaveBeenCalledWith(["duckdb", "redis"]);
  });

  it("disables export after clearing the selection", async () => {
    i18n.global.locale.value = "en";
    const { onConfirm } = await mountDialog({ open: true, preview });

    buttonContaining("Clear")?.click();
    await nextTick();

    expect(document.body.textContent).toContain("0 of 2 selected");
    const confirm = buttonContaining("Export 0 driver(s)");
    expect(confirm?.disabled).toBe(true);
    confirm?.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks controls while an export is running", async () => {
    i18n.global.locale.value = "en";
    const { onConfirm } = await mountDialog({ open: true, preview, exporting: true });

    expect(buttonContaining("Select all")?.disabled).toBe(true);
    expect(buttonContaining("Clear")?.disabled).toBe(true);
    expect(buttonContaining("Cancel")?.disabled).toBe(true);
    expect(buttonContaining("Exporting")?.disabled).toBe(true);
    expect([...document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].every((input) => input.disabled)).toBe(true);
    buttonContaining("Exporting")?.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the empty state when no managed drivers are available", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ open: true, preview: { platform: "linux-x64", candidates: [] } satisfies AgentOfflineExportPreview });

    expect(document.body.textContent).toContain("No eligible DBX-managed Agent drivers are installed.");
    expect(buttonContaining("Export 0 driver(s)")?.disabled).toBe(true);
  });
});
