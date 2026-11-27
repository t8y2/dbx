// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from "vue";
import { expect, it } from "vitest";
import i18n from "@/i18n";
import { resolveConnectionWatermark } from "@/lib/connection/connectionWatermark";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import type { ConnectionWatermarkConfig } from "@/types/database";
import ConnectionWatermarkSettings from "../ConnectionWatermarkSettings.vue";

it("updates the watermark preview as text, font size and color change", async () => {
  const settings = ref<ConnectionWatermarkConfig>({ mode: "custom" });
  const host = document.createElement("div");
  document.body.append(host);
  i18n.global.locale.value = "en";
  const app = createApp({
    render: () =>
      h(ConnectionWatermarkSettings, {
        connectionName: "Staging",
        modelValue: settings.value,
        "onUpdate:modelValue": (value) => {
          if (value) settings.value = value;
        },
      }),
  }).use(i18n);
  app.mount(host);

  try {
    async function input(selector: string, value: string) {
      const element = host.querySelector<HTMLInputElement>(selector)!;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
      await nextTick();
    }

    const label = () => host.querySelector<HTMLElement>("figure .connection-watermark__label")!;
    expect(label().textContent?.trim()).toBe("Staging");
    await input('input[maxlength="48"]', "SIT");
    await input('input[type="range"]', "52");
    await input('input[type="color"]', "#008844");
    expect(settings.value).toEqual({ mode: "custom", text: "SIT", font_size: 52, color: "#008844" });
    expect(label().textContent?.trim()).toBe("SIT");
    expect(label().style.getPropertyValue("--connection-watermark-font-size")).toBe("52px");
    expect(label().style.color).toBe("#008844");

    settings.value = { ...settings.value, mode: "off" };
    await nextTick();
    expect(host.querySelector("figure")).toBeNull();
  } finally {
    app.unmount();
    host.remove();
  }
});

it("uses production database scope only for automatic watermarks", () => {
  const connection = { db_type: "postgres", name: "Mixed environment", production_databases: ["live"] } as const;
  const config = { ...connection, production_databases: [...connection.production_databases] };
  const production = productionContextForDatabase(config, "live").active;
  const staging = productionContextForDatabase(config, "staging").active;
  expect(production).toBe(true);
  expect(staging).toBe(false);
  expect(resolveConnectionWatermark(config, production)).toEqual({});
  expect(resolveConnectionWatermark(config, staging)).toBeUndefined();
  expect(resolveConnectionWatermark({ ...config, watermark: { mode: "off" } }, production)).toBeUndefined();
  expect(resolveConnectionWatermark({ ...config, watermark: { mode: "custom", text: "UAT" } }, staging)?.text).toBe("UAT");
});
