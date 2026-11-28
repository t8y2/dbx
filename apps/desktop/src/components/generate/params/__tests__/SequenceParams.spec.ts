// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { expect, it, vi } from "vitest";
import SequenceParams from "../SequenceParams.vue";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it("keeps large integer sequence input exact and previews exact values", async () => {
  const params = reactive<GeneratorParams>({});
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(SequenceParams, { params }) });
  app.mount(host);
  await nextTick();

  const inputs = host.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]');
  inputs[0]!.value = "12345678901234567890";
  inputs[0]!.dispatchEvent(new Event("input"));
  inputs[1]!.value = "10";
  inputs[1]!.dispatchEvent(new Event("input"));
  await nextTick();

  expect(params.startValue).toBe("12345678901234567890");
  expect(params.increment).toBe("10");
  expect(host.textContent).toContain("12345678901234567890, 12345678901234567900");
  app.unmount();
  host.remove();
});
