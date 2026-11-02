// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "",
  getSqlFileFolderPaths: () => [],
  saveSqlFileFilter: vi.fn(),
  saveSqlFileFolderPaths: vi.fn(),
  notifySqlFileFoldersChanged: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

function mountPanel() {
  setActivePinia(createPinia());
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("SQL file panel storage help", () => {
  it("shows a help button next to the title", async () => {
    const host = mountPanel();
    await nextTick();

    const header = host.querySelector(".h-9");
    expect(header).not.toBeNull();

    const label = i18n.global.t("sqlFileTree.storageHelp");
    const helpButton = header!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(helpButton).not.toBeNull();
    expect(helpButton!.querySelector("svg")).not.toBeNull();
  });

  it("keeps the help button directly after the panel title", async () => {
    const host = mountPanel();
    await nextTick();

    const header = host.querySelector(".h-9")!;
    const title = header.querySelector("span");
    expect(title?.textContent?.trim()).toBe(i18n.global.t("sqlFileTree.title"));
    const helpButton = title?.nextElementSibling?.querySelector<HTMLButtonElement>("button[aria-label]");
    expect(helpButton?.getAttribute("aria-label")).toBe(i18n.global.t("sqlFileTree.storageHelp"));
  });
});
