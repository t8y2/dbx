// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActiveConnectionFilterButton from "../ActiveConnectionFilterButton.vue";

vi.mock("@/components/ui/LightTooltip.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "LightTooltipStub",
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
  };
});

const mountedApps: App[] = [];

async function mountFilter(activeConnectionCount: number) {
  const state = reactive({ activeConnectionCount, pressed: false });
  const host = defineComponent({
    setup: () => () =>
      h(ActiveConnectionFilterButton, {
        activeConnectionCount: state.activeConnectionCount,
        pressed: state.pressed,
        onToggle: () => {
          state.pressed = !state.pressed;
        },
      }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(host);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          sidebar: {
            activeConnectionsStatus: "Active connections: {count}",
            showActiveConnectionsOnly: "Show active connections only",
          },
        },
      },
    }),
  );
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  const button = container.querySelector("[data-active-connection-filter]");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Active connection filter button was not rendered");
  return { button, state };
}

function describedStatus(button: HTMLButtonElement) {
  const statusId = button.getAttribute("aria-describedby");
  if (!statusId) throw new Error("Active connection status description is missing");
  const status = document.getElementById(statusId);
  if (!(status instanceof HTMLSpanElement)) throw new Error("Active connection status element was not rendered");
  return status;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ActiveConnectionFilterButton", () => {
  it("morphs the centered indicator as the active connection status changes from 0 to 1 to 0", async () => {
    const { button, state } = await mountFilter(0);

    const indicator = button.querySelector("[data-active-connection-filter-icon]");
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("left-1/2 top-1/2");
    expect(indicator?.className).toContain("h-3 w-3 border-current bg-transparent");
    expect(describedStatus(button).textContent).toBe("Active connections: 0");

    state.activeConnectionCount = 1;
    await nextTick();
    expect(button.querySelector("[data-active-connection-filter-icon]")).toBe(indicator);
    expect(indicator?.className).toContain("h-1.5 w-1.5 border-green-500 bg-green-500");
    expect(describedStatus(button).textContent).toBe("Active connections: 1");

    state.activeConnectionCount = 0;
    await nextTick();
    expect(button.querySelector("[data-active-connection-filter-icon]")).toBe(indicator);
    expect(indicator?.className).toContain("h-3 w-3 border-current bg-transparent");
    expect(describedStatus(button).textContent).toBe("Active connections: 0");
  });

  it("preserves the pressed and unpressed filter states", async () => {
    const { button } = await mountFilter(1);

    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    await nextTick();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    await nextTick();
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
