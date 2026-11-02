// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimeParams from "../TimeParams.vue";
import DateTimeParams from "../DateTimeParams.vue";
import { generateValue, type GeneratorParams } from "@/lib/dataGrid/dataGenerate";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe.each(["time", "datetime"] as const)("%s range preview", (kind) => {
  it("matches generation and updates when minute bounds are edited", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const params = reactive<GeneratorParams>({ allDay: kind === "datetime", start: "2026-10-17", end: "2026-10-17", startTime: "09:15", endTime: "09:20" });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(kind === "time" ? TimeParams : DateTimeParams, { params }) });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
    app.mount(host);
    cleanups.push(() => {
      app.unmount();
      host.remove();
    });
    const generated = () => String(generateValue("t", kind, kind, 1, params));
    expect(generated()).toContain("09:17:30");
    expect(host.textContent).toContain(generated());

    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="time"]');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      input.value = "00:00";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextTick();
    expect(generated()).toContain("00:00:00");
    expect(host.textContent).toContain(generated());
    const random = vi.spyOn(Math, "random");
    random.mockClear();
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).at(-1)?.click();
    await nextTick();
    expect(random).toHaveBeenCalled();
    expect(host.textContent).toContain(generated());
  });
});
