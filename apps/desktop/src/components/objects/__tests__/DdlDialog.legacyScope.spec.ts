// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import DdlScopeFixture from "./DdlDialog.legacyScope.fixture.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps) app.unmount();
  mountedApps.length = 0;
  document.body.innerHTML = "";
});

async function flushFrames(frames = 4) {
  for (let i = 0; i < frames; i += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountFixture() {
  const host = defineComponent({
    setup: () => () => h(DdlScopeFixture),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(host);
  app.use(
    createI18n({
      legacy: false,
      locale: "zh-CN",
      messages: { "zh-CN": {} },
    }),
  );
  app.mount(container);
  mountedApps.push(app);
}

describe("DdlViewDialog legacy fallback selectors", () => {
  it("does not deliver the parent scope attribute to teleported dialog content", async () => {
    mountFixture();
    await flushFrames();

    const scopeId = (DdlScopeFixture as unknown as { __scopeId?: string }).__scopeId;
    expect(scopeId).toMatch(/^data-v-/);

    const content = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    const footer = document.body.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain("dbx-ddl-view-dialog");
    expect(content!.className).toContain("max-w-sm");
    // The dialog content element is rendered by the child DialogContent component
    // through reka-ui's portal Teleport, so the parent scoped-style attribute
    // never reaches it; the footer element is one level down and does get it.
    expect(content!.hasAttribute(scopeId!)).toBe(false);
    expect(footer!.hasAttribute(scopeId!)).toBe(true);
  });
});
