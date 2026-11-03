// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import ChangelogPanel from "@/components/settings/ChangelogPanel.vue";

const changelogMocks = vi.hoisted(() => ({
  fetchChangelogIndex: vi.fn(),
  fetchChangelogRelease: vi.fn(),
}));

vi.mock("@/lib/app/changelog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app/changelog")>();
  return { ...actual, fetchChangelogIndex: changelogMocks.fetchChangelogIndex, fetchChangelogRelease: changelogMocks.fetchChangelogRelease };
});

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const mountedApps: App[] = [];

async function flushPanel() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function entry(tag: string) {
  return { tag, name: `DBX ${tag}`, date: "2026-10-30" };
}

function entries(count: number) {
  return Array.from({ length: count }, (_, index) => entry(`v0.6.${count - index}`));
}

function release(tag: string) {
  return {
    tag,
    name: `DBX ${tag}`,
    date: "2026-10-30",
    sections: [{ type: "fixed", title: "Fixed", items: [{ title: `${tag} fix note`, desc: "" }] }],
  };
}

function releaseRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"));
}

function buttonWithText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(text));
}

async function mountPanel(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(ChangelogPanel) }));
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushPanel();
  return container;
}

beforeEach(() => {
  changelogMocks.fetchChangelogIndex.mockResolvedValue({ updatedAt: "2026-10-30", releases: entries(8) });
  changelogMocks.fetchChangelogRelease.mockImplementation(async (_lang: string, tag: string) => release(tag));
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ChangelogPanel lazy release bodies", () => {
  it("loads only the version index up front and pulls a body when a version is expanded", async () => {
    const container = await mountPanel();

    expect(changelogMocks.fetchChangelogIndex).toHaveBeenCalledTimes(1);
    expect(changelogMocks.fetchChangelogRelease).not.toHaveBeenCalled();
    // The first page is list metadata only: no release notes travel with it.
    expect(releaseRows(container)).toHaveLength(5);
    expect(container.textContent).not.toContain("v0.6.8 fix note");

    releaseRows(container)[0].click();
    await flushPanel();

    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledTimes(1);
    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledWith(expect.any(String), "v0.6.8");
    expect(container.textContent).toContain("v0.6.8 fix note");
    // Untouched versions stay unfetched.
    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledTimes(1);
  });

  it("reveals more versions on load more without downloading their notes", async () => {
    const container = await mountPanel();
    expect(releaseRows(container)).toHaveLength(5);

    buttonWithText(container, i18n.global.t("settings.changelogLoadMore"))?.click();
    await flushPanel();

    expect(releaseRows(container)).toHaveLength(8);
    expect(changelogMocks.fetchChangelogRelease).not.toHaveBeenCalled();
    expect(buttonWithText(container, i18n.global.t("settings.changelogLoadMore"))).toBeUndefined();
  });

  it("keeps a loaded body in memory when the version is collapsed and expanded again", async () => {
    const container = await mountPanel();

    releaseRows(container)[0].click();
    await flushPanel();
    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledTimes(1);

    releaseRows(container)[0].click();
    await flushPanel();
    releaseRows(container)[0].click();
    await flushPanel();

    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("v0.6.8 fix note");
  });

  it("surfaces a body load failure with a retry that renders the notes", async () => {
    changelogMocks.fetchChangelogRelease.mockRejectedValueOnce(new Error("offline"));
    const container = await mountPanel();

    releaseRows(container)[0].click();
    await flushPanel();

    expect(container.textContent).toContain(i18n.global.t("settings.changelogLoadFailed"));

    buttonWithText(container, i18n.global.t("settings.changelogRetry"))?.click();
    await flushPanel();

    expect(changelogMocks.fetchChangelogRelease).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("v0.6.8 fix note");
    expect(container.textContent).not.toContain(i18n.global.t("settings.changelogLoadFailed"));
  });
});
