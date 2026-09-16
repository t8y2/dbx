// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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

import ElasticsearchProfilePanel from "@/components/common/ElasticsearchProfilePanel.vue";

const SAMPLE_BODY = JSON.stringify({
  took: 42,
  profile: {
    shards: [
      {
        id: "[node1][products][0]",
        searches: [
          {
            query: [
              {
                type: "BooleanQuery",
                description: "title:text description:text",
                time_in_nanos: 1234567,
                breakdown: { build_scorer: 40000, next_doc: 300000 },
                children: [
                  { type: "TermQuery", description: "title:dbx", time_in_nanos: 500000, breakdown: { score: 250000 }, children: [] },
                  { type: "TermQuery", description: "description:profiler", time_in_nanos: 300000, children: [] },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "[node1][products][1]",
        searches: [
          {
            query: [{ type: "TermQuery", description: "title:dbx", time_in_nanos: 900000, children: [] }],
          },
        ],
      },
    ],
  },
});

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountPanel(body: string) {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(
    defineComponent({
      setup() {
        return () => h(ElasticsearchProfilePanel, { body });
      },
    }),
  );
  app.mount(root);
  await flushUi();
}

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
});

describe("ElasticsearchProfilePanel rendering", () => {
  it("renders the query tree with type, description, self time and total time", async () => {
    await mountPanel(SAMPLE_BODY);
    const rootEl = root!.querySelector("[data-elasticsearch-profile-root]");
    expect(rootEl).not.toBeNull();
    expect(rootEl!.textContent).toContain("BooleanQuery");
    expect(rootEl!.textContent).toContain("title:text description:text");
    expect(rootEl!.textContent).toContain("TermQuery");
    // self/total chips for the BooleanQuery root: 434567ns self, 1234567ns total.
    expect(rootEl!.textContent).toContain("435µs");
    expect(rootEl!.textContent).toContain("1.2ms");
  });

  it("shows shard pills and defaults to the highest-total shard", async () => {
    await mountPanel(SAMPLE_BODY);
    const shardButtons = [...root!.querySelectorAll<HTMLButtonElement>("[data-elasticsearch-profile-root] button")].filter((button) => button.textContent === "[node1][products][1]" || button.textContent === "[node1][products][0]");
    expect(shardButtons).toHaveLength(2);
    expect(shardButtons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(shardButtons[1]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("marks critical-path nodes and keeps a breakdown row for expanded nodes", async () => {
    await mountPanel(SAMPLE_BODY);
    const rootEl = root!.querySelector("[data-elasticsearch-profile-root]")!;
    // The critical-path tag is rendered next to the BooleanQuery and its hot child.
    expect(rootEl.textContent).toContain("profile.criticalPathTag");
    expect(rootEl.textContent).toContain("breakdown");
    expect(rootEl.textContent).toContain("build_scorer");
  });

  it("shows a friendly empty state instead of crashing for non-profile bodies", async () => {
    await mountPanel('{"hits":{"total":0,"hits":[]}}');
    expect(root!.querySelector("[data-profile-empty]")?.textContent).toContain("profile.emptyProfile");
  });
});
