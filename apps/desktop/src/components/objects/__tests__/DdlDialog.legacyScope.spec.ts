// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import DdlScopeFixture from "./DdlDialog.legacyScope.fixture.vue";

const ddlViewDialogSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/objects/DdlViewDialog.vue"), "utf8");

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

  it("keeps the DDL dialog free of per-dialog legacy fallback rules", () => {
    // The dialog content element is rendered through reka-ui's portal Teleport and
    // never carries this component's scoped data-v attribute, so per-dialog rules
    // are avoided entirely: width comes from the global sm:max-w-190 legacy entry
    // and the footer layout from the global dialog-footer rule.
    expect(ddlViewDialogSource).not.toContain("dbx-legacy-webview");
    expect(ddlViewDialogSource).not.toContain("@media");
    expect(ddlViewDialogSource).toContain('class="dbx-ddl-view-dialog sm:max-w-190"');
  });
});
