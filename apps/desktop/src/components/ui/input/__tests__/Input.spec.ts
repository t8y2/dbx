// @vitest-environment happy-dom

import { createApp, nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import Input from "@/components/ui/input/Input.vue";

const mountedApps: Array<ReturnType<typeof createApp>> = [];

async function mountInput(template: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    components: { Input },
    setup() {
      return { value: ref("1") };
    },
    template,
  });
  app.mount(host);
  mountedApps.push(app);
  await nextTick();
  return host;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("Input", () => {
  it("uses the plain input for non-number fields", async () => {
    const host = await mountInput('<Input v-model="value" />');

    expect(host.querySelector(".dbx-number-stepper")).toBeNull();
    expect(host.querySelectorAll("input")).toHaveLength(1);
  });

  it("uses large custom steppers for number fields", async () => {
    const host = await mountInput('<Input v-model="value" type="number" step="2" /><span data-value>{{ value }}</span>');
    const input = host.querySelector("input") as HTMLInputElement;
    const buttons = Array.from(host.querySelectorAll(".dbx-number-stepper-button")) as HTMLButtonElement[];

    Object.defineProperty(input, "stepUp", {
      configurable: true,
      value: () => {
        input.value = String(Number(input.value || 0) + 2);
      },
    });
    Object.defineProperty(input, "stepDown", {
      configurable: true,
      value: () => {
        input.value = String(Number(input.value || 0) - 2);
      },
    });

    expect(buttons).toHaveLength(2);
    expect(host.querySelector(".dbx-number-stepper-icon")).not.toBeNull();

    buttons[0].click();
    await nextTick();
    expect(host.querySelector("[data-value]")?.textContent).toBe("3");

    buttons[1].click();
    await nextTick();
    expect(host.querySelector("[data-value]")?.textContent).toBe("1");
  });

  it("keeps layout classes on the number input wrapper without moving input-only classes there", async () => {
    const host = await mountInput('<Input v-model="value" type="number" class="settings-export-number-input h-8 w-28 text-xs" />');
    const wrapper = host.querySelector(".dbx-number-input-wrapper") as HTMLElement;
    const input = host.querySelector("input") as HTMLInputElement;

    expect(wrapper.className).toContain("w-28");
    expect(wrapper.className).not.toContain("settings-export-number-input");
    expect(wrapper.className).not.toContain("h-8");
    expect(input.className).toContain("settings-export-number-input");
    expect(input.className).toContain("h-8");
  });
});
