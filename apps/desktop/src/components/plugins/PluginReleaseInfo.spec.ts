// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import type { PluginMarketplaceVersion } from "@/types/database";
import PluginReleaseInfo from "./PluginReleaseInfo.vue";

const mountedApps: App[] = [];

function release(overrides: Partial<PluginMarketplaceVersion> = {}): PluginMarketplaceVersion {
  return {
    version: "1.1.0",
    artifacts: [],
    ...overrides,
  };
}

async function mountReleaseInfo(value?: PluginMarketplaceVersion) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(PluginReleaseInfo, { release: value });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("PluginReleaseInfo", () => {
  it("shows the date and opens release notes in a plain-text dialog on demand", async () => {
    const container = await mountReleaseInfo(
      release({
        releasedAt: "2026-07-28T00:00:00Z",
        releaseNotes: "First line\nSecond line\n<b>not HTML</b>",
      }),
    );

    const toggle = container.querySelector<HTMLButtonElement>("button");
    expect(container.textContent).toContain("Updated Jul 28, 2026");
    expect(container.textContent).not.toContain("First line");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-plugin-release-notes]")).toBeNull();

    toggle?.click();
    await nextTick();

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector("[data-plugin-release-notes]")?.textContent).toContain("First line\nSecond line\n<b>not HTML</b>");
    expect(document.body.querySelector("[data-plugin-release-notes] b")).toBeNull();
    expect(document.body.textContent).toContain("Release notes");
    expect(document.body.textContent).toContain("Version 1.1.0");

    document.body.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector("[data-plugin-release-notes]")).toBeNull();
  });

  it("omits the release section when the catalog has no usable metadata", async () => {
    const container = await mountReleaseInfo(release({ releasedAt: "not-a-date", releaseNotes: "   " }));

    expect(container.querySelector("[class*='space-y']")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("can show notes without a release date", async () => {
    const container = await mountReleaseInfo(release({ releaseNotes: "Notes only" }));

    expect(container.textContent).not.toContain("Notes only");
    expect(container.textContent).not.toContain("Updated");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(document.body.querySelector("[data-plugin-release-notes]")?.textContent).toContain("Notes only");
  });
});
