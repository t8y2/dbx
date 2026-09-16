// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type App, type ComponentPublicInstance } from "vue";

const backend = vi.hoisted(() => ({
  mqListTopics: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@lucide/vue", async () => {
  const { defineComponent: defineIcon, h: render } = await import("vue");
  const Icon = defineIcon({ name: "Icon", setup: () => () => render("i") });
  return { Search: Icon };
});

import RocketMqTopicSelect from "@/components/mq/shared/RocketMqTopicSelect.vue";

type TopicSelectExposed = ComponentPublicInstance & { loading: boolean };

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

beforeEach(() => {
  backend.mqListTopics.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("RocketMqTopicSelect request state", () => {
  it("clears loading when the request context becomes incomplete", async () => {
    backend.mqListTopics.mockReturnValue(new Promise(() => undefined));
    const tenant = ref<string>();
    const selector = ref<TopicSelectExposed>();
    const Wrapper = defineComponent({
      setup() {
        return () =>
          h(RocketMqTopicSelect, {
            ref: selector,
            modelValue: "",
            connectionId: "mq-1",
            tenant: tenant.value,
            namespace: "default",
          });
      },
    });

    root = document.createElement("div");
    document.body.appendChild(root);
    tenant.value = "tenant-a";
    app = createApp(Wrapper);
    app.mount(root);
    await flushUi();
    expect(selector.value?.loading).toBe(true);

    tenant.value = undefined;
    await flushUi();

    expect(selector.value?.loading).toBe(false);
  });
});
