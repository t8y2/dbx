// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { SearchableSelect } from "..";

const mountedApps: App[] = [];

function mountSelect(props: Record<string, unknown> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const emitted = { modelValue: [] as unknown[], open: [] as unknown[] };
  const app = createApp(SearchableSelect, {
    modelValue: "Point",
    options: ["Point", "LineString"],
    placeholder: "type",
    searchPlaceholder: "search",
    emptyText: "empty",
    ...props,
    "onUpdate:modelValue": (value: unknown) => emitted.modelValue.push(value),
    "onUpdate:open": (value: unknown) => emitted.open.push(value),
  });
  mountedApps.push(app);
  app.mount(root);
  return { root, emitted };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SearchableSelect trigger", () => {
  it("renders the trigger button itself as the layout participant", () => {
    const { root } = mountSelect({ triggerClass: "min-w-0 flex-1" });

    const trigger = root.querySelector("button");

    // No wrapper element may sit between the parent layout context and the
    // trigger: triggerClass utilities (flex-1 / min-w-0 / max-w-*) must stay
    // effective on the element the consumer lays out.
    expect(trigger).not.toBeNull();
    expect(root.firstElementChild).toBe(trigger);
    expect(trigger?.className).toContain("flex-1");
    expect(trigger?.className).toContain("min-w-0");
  });

  it("clears through the overlay without toggling the popover open", async () => {
    const { root, emitted } = mountSelect({ clearable: true });

    const clear = root.querySelector<HTMLElement>('[title="common.clear"]');
    expect(clear).not.toBeNull();
    expect(clear?.getAttribute("aria-label")).toBe("common.clear");

    clear?.click();
    await nextTick();

    expect(emitted.modelValue).toEqual([""]);
    expect(emitted.open).toEqual([]);
  });

  it("keeps the chevron space reserved while the clear overlay is shown", () => {
    const { root } = mountSelect({ clearable: true });

    expect(root.querySelector("button .invisible")).not.toBeNull();
  });
});
