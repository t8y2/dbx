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

    expect(host.querySelectorAll("input")).toHaveLength(1);
  });

  it("keeps number fields as native inputs and preserves narrow layout classes", async () => {
    const host = await mountInput('<Input v-model="value" type="number" step="2" class="w-14" />');

    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelector("input")?.className).toContain("w-14");
  });
});
