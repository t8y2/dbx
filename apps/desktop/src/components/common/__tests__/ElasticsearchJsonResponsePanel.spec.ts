// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type ComponentPublicInstance } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openJsonSearch: vi.fn().mockReturnValue(true),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        modelValue: { type: String, required: true },
        readOnly: { type: Boolean, default: false },
      },
      setup(props, { expose }) {
        expose({ openSearch: mocks.openJsonSearch });
        return () => h("div", { "data-redis-json-editor-stub": "", "data-read-only": String(props.readOnly) }, props.modelValue);
      },
    }),
  };
});

vi.mock("@/components/common/TextContentSearchBar.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        modelValue: { type: String, required: true },
        status: { type: String, required: true },
        matchCount: { type: Number, required: true },
      },
      emits: ["update:modelValue", "activate", "prev", "next", "close"],
      setup(props, { emit, expose }) {
        const input = ref<HTMLInputElement>();
        expose({ focusInput: () => input.value?.focus() });
        return () =>
          h("div", { "data-elasticsearch-response-search": "" }, [
            h("input", {
              ref: input,
              "data-elasticsearch-response-search-input": "",
              value: props.modelValue,
              onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
            }),
            h("span", { "data-elasticsearch-response-search-status": "" }, props.status),
            h("button", { "data-elasticsearch-response-search-prev": "", onClick: () => emit("prev") }),
            h("button", { "data-elasticsearch-response-search-next": "", onClick: () => emit("next") }),
            h("button", { "data-elasticsearch-response-search-close": "", onClick: () => emit("close") }),
          ]);
      },
    }),
  };
});

import ElasticsearchJsonResponsePanel from "@/components/common/ElasticsearchJsonResponsePanel.vue";

type SearchablePanel = ComponentPublicInstance & { focusSearch: () => boolean };

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountResponsePanel(body = '{"first":"needle","second":"<needle>"}', raw = true) {
  const panelRef = ref<SearchablePanel>();
  const bodyRef = ref(body);
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(
    defineComponent({
      setup() {
        return () => h(ElasticsearchJsonResponsePanel, { ref: panelRef, status: 200, body: bodyRef.value });
      },
    }),
  );
  app.mount(root);
  await flushUi();

  const panelElement = root.querySelector<HTMLElement>("[data-elasticsearch-json-response-root]");
  const rawButton = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "redis.rawContent");
  if (!panelElement || !rawButton || !panelRef.value) throw new Error("Failed to mount Elasticsearch response panel");
  if (raw) {
    rawButton.click();
    await flushUi();
  }
  return {
    panel: panelRef.value,
    panelElement,
    async setBody(nextBody: string) {
      bodyRef.value = nextBody;
      await flushUi();
    },
  };
}

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  mocks.openJsonSearch.mockClear();
});

describe("ElasticsearchJsonResponsePanel search", () => {
  it("uses the read-only Redis JSON editor for formatted JSON responses", async () => {
    const { panel, panelElement } = await mountResponsePanel('{"name":"Ada"}', false);
    const editor = root!.querySelector<HTMLElement>("[data-redis-json-editor-stub]");

    expect(editor?.getAttribute("data-read-only")).toBe("true");
    expect(editor?.textContent).toBe('{\n  "name": "Ada"\n}');

    panelElement.focus();
    expect(panel.focusSearch()).toBe(true);
    await flushUi();
    expect(mocks.openJsonSearch).toHaveBeenCalledOnce();
  });

  it("opens a find panel only while the response has focus, highlights literal matches, and navigates them", async () => {
    const { panel, panelElement } = await mountResponsePanel();

    expect(panel.focusSearch()).toBe(false);
    panelElement.focus();
    expect(panel.focusSearch()).toBe(true);
    await flushUi();

    const input = root!.querySelector<HTMLInputElement>("[data-elasticsearch-response-search-input]");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    input!.value = "needle";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    expect(root!.querySelector("[data-elasticsearch-response-search-status]")?.textContent).toBe("1/2");
    expect(root!.querySelectorAll(".document-search-match")).toHaveLength(2);
    expect(root!.querySelector('[data-document-search-active="true"]')?.getAttribute("data-document-search-match")).toBe("0");
    expect(root!.querySelector("needle")).toBeNull();

    root!.querySelector<HTMLButtonElement>("[data-elasticsearch-response-search-next]")!.click();
    await flushUi();
    expect(root!.querySelector('[data-document-search-active="true"]')?.getAttribute("data-document-search-match")).toBe("1");
  });

  it("clears search state when closed", async () => {
    const { panel, panelElement } = await mountResponsePanel();
    panelElement.focus();
    panel.focusSearch();
    await flushUi();

    const input = root!.querySelector<HTMLInputElement>("[data-elasticsearch-response-search-input]")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    root!.querySelector<HTMLButtonElement>("[data-elasticsearch-response-search-close]")!.click();
    await flushUi();

    expect(root!.querySelector("[data-elasticsearch-response-search]")).toBeNull();
    expect(root!.querySelectorAll(".document-search-match")).toHaveLength(0);
    expect(document.activeElement).toBe(panelElement);
  });

  it("resets an open raw search when the response changes", async () => {
    const { panel, panelElement, setBody } = await mountResponsePanel();
    panelElement.focus();
    panel.focusSearch();
    await flushUi();

    const input = root!.querySelector<HTMLInputElement>("[data-elasticsearch-response-search-input]")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    expect(root!.querySelectorAll(".document-search-match")).toHaveLength(2);

    await setBody('{"fresh":"response"}');
    expect(root!.querySelector("[data-elasticsearch-response-search]")).toBeNull();
    expect(root!.querySelectorAll(".document-search-match")).toHaveLength(0);
    expect(root!.querySelector("[data-redis-json-editor-stub]")?.textContent).toBe('{\n  "fresh": "response"\n}');
  });

  it("keeps invalid response bodies searchable in the raw view", async () => {
    const invalid = await mountResponsePanel("not JSON", false);
    expect([...root!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "redis.jsonView")?.disabled).toBe(true);
    invalid.panelElement.focus();
    expect(invalid.panel.focusSearch()).toBe(true);
    await flushUi();
    expect(root!.querySelector("[data-elasticsearch-response-search-input]")).not.toBeNull();
  });

  it("searches large raw responses without rendering all highlight nodes", async () => {
    const large = await mountResponsePanel(`${"x".repeat(256_001)}needle`, false);
    large.panelElement.focus();
    large.panel.focusSearch();
    await flushUi();
    const input = root!.querySelector<HTMLInputElement>("[data-elasticsearch-response-search-input]")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    expect(root!.querySelector("[data-elasticsearch-response-search-status]")?.textContent).toBe("1/1");
    expect(root!.querySelectorAll(".document-search-match")).toHaveLength(0);
  });
});
