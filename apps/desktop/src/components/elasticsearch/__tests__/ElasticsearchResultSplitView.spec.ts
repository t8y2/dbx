// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElasticsearchDocumentHit } from "@/lib/elasticsearch/elasticsearchDocumentHits";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));

vi.mock("splitpanes", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Splitpanes: defineComponent({
      setup(_, { slots }) {
        return () => h("div", { "data-splitpanes": "" }, slots.default?.());
      },
    }),
    Pane: defineComponent({
      setup(_, { slots }) {
        return () => h("div", { "data-pane": "" }, slots.default?.());
      },
    }),
  };
});
vi.mock("splitpanes/dist/splitpanes.css", () => ({}));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      props: { disabled: { type: Boolean, default: false } },
      setup(props, { attrs, slots }) {
        return () => h("button", { ...attrs, disabled: props.disabled }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: { type: String, default: "" } },
      emits: ["update:modelValue"],
      setup(props, { emit, attrs }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, required: true }, readOnly: { type: Boolean, default: false } },
      setup(props) {
        return () => h("pre", { "data-redis-json-editor-stub": "", "data-read-only": String(props.readOnly) }, props.modelValue);
      },
    }),
  };
});

import ElasticsearchResultSplitView from "@/components/elasticsearch/ElasticsearchResultSplitView.vue";

function documents(count: number): ElasticsearchDocumentHit[] {
  return Array.from({ length: count }, (_, index) => ({
    label: "doc-" + (index + 1),
    index: "logs-2026",
    record: { _id: "doc-" + (index + 1), _source: { n: index } },
  }));
}

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountSplitView(props: Record<string, unknown>, onPaginate = vi.fn()) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(
    defineComponent({
      setup() {
        return () => h(ElasticsearchResultSplitView, { ...props, onPaginate });
      },
    }),
  );
  app.mount(root);
  await flushUi();
  return { root: root as HTMLDivElement, onPaginate };
}

function listLabels(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((button) => button.textContent?.trim() ?? "");
}

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
  document.body.innerHTML = "";
});

describe("ElasticsearchResultSplitView", () => {
  it("lists the hits and shows the first document by default", async () => {
    const { root: container } = await mountSplitView({ documents: documents(3) });

    expect(listLabels(container)).toHaveLength(3);
    expect(container.querySelector('[data-document-active="true"]')?.textContent).toContain("doc-1");
    expect(container.querySelector("[data-redis-json-editor-stub]")?.textContent).toContain('"_id": "doc-1"');
    expect(container.querySelector("[data-redis-json-editor-stub]")?.getAttribute("data-read-only")).toBe("true");
  });

  it("switches the detail pane when another hit is selected", async () => {
    const { root: container } = await mountSplitView({ documents: documents(3) });
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];

    options[2]?.click();
    await flushUi();

    expect(container.querySelector('[data-document-active="true"]')?.textContent).toContain("doc-3");
    expect(container.querySelector("[data-redis-json-editor-stub]")?.textContent).toContain('"_id": "doc-3"');
  });

  it("filters the list by id and reports an empty filter state", async () => {
    const { root: container } = await mountSplitView({ documents: documents(3) });
    const input = container.querySelector<HTMLInputElement>("input") as HTMLInputElement;

    input.value = "doc-2";
    input.dispatchEvent(new Event("input"));
    await flushUi();
    expect(listLabels(container)).toHaveLength(1);

    input.value = "missing";
    input.dispatchEvent(new Event("input"));
    await flushUi();
    expect(listLabels(container)).toHaveLength(0);
    expect(container.textContent).toContain("esResult.emptyFilter");
  });

  it("renders an empty state instead of a blank pane", async () => {
    const { root: container } = await mountSplitView({ documents: [] });

    expect(container.textContent).toContain("esResult.empty");
    expect(container.textContent).toContain("esResult.detailEmpty");
    expect(container.querySelector("[data-redis-json-editor-stub]")).toBeNull();
  });

  it("requests the next page and resets the selection when the page changes", async () => {
    const { root: container, onPaginate } = await mountSplitView({ documents: documents(50), canPaginate: true, pageOffset: 0, pageLimit: 50 });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const next = buttons.find((button) => button.textContent === "esResult.next");

    next?.click();
    await flushUi();
    expect(onPaginate).toHaveBeenCalledWith(50, 50);

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    options[4]?.click();
    await flushUi();
    expect(container.querySelector('[data-document-active="true"]')?.textContent).toContain("doc-5");

    // A fresh page keeps the list scrolled to the top instead of a stale index.
    const { root: second } = await mountSplitView({ documents: documents(50), canPaginate: true, pageOffset: 50, pageLimit: 50 });
    expect(second.querySelector('[data-document-active="true"]')?.textContent).toContain("doc-1");
  });

  it("hides pagination when the caller cannot re-run the query", async () => {
    const { root: container } = await mountSplitView({ documents: documents(2) });

    expect(container.textContent).not.toContain("esResult.next");
  });
});
