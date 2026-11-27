// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import NumberParams from "../NumberParams.vue";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("keeps large integer range input exact and previews an exact value", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const params = reactive<GeneratorParams>({});
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(NumberParams, { params }) });
  app.mount(host);
  await nextTick();

  const inputs = host.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]');
  inputs[0]!.value = "12345678901234567890";
  inputs[0]!.dispatchEvent(new Event("input"));
  inputs[1]!.value = "12345678901234567899";
  inputs[1]!.dispatchEvent(new Event("input"));
  await nextTick();

  expect(params.min).toBe("12345678901234567890");
  expect(params.max).toBe("12345678901234567899");
  expect(host.textContent).toContain("12345678901234567890");
  app.unmount();
});
