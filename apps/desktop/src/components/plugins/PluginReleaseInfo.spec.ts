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
  it("shows the date and opens markdown release notes on demand", async () => {
    const container = await mountReleaseInfo(
      release({
        releasedAt: "2026-07-28T00:00:00Z",
        releaseNotes: "# What's new\n\nFirst line\nSecond line\n\n**Bold change**\n\n- Faster startup\n- Better errors\n\n`plugin-cli`\n\n<b>not HTML</b>",
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
    const notes = document.body.querySelector<HTMLElement>("[data-plugin-release-notes]");
    expect(notes?.querySelector("h1")?.textContent).toBe("What's new");
    expect(notes?.querySelector("strong")?.textContent).toBe("Bold change");
    expect(notes?.querySelectorAll("ul li")).toHaveLength(2);
    expect(notes?.querySelector("code")?.textContent).toBe("plugin-cli");
    expect(notes?.innerHTML).toContain("<br>");
    expect(notes?.querySelector("script, img, b")).toBeNull();
    expect(notes?.textContent).toContain("<b>not HTML</b>");
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
