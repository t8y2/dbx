// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import UpdateDialog from "@/components/layout/UpdateDialog.vue";

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

const mountedApps: App[] = [];

async function mountDialog(activeTaskCount: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(UpdateDialog, {
    open: true,
    "onUpdate:open": () => {},
    updateInfo: {
      current_version: "0.5.60",
      latest_version: "0.5.61",
      update_available: true,
      portable_mode: false,
      release_name: "DBX v0.5.61",
      release_url: "https://github.com/t8y2/dbx/releases/tag/v0.5.61",
      release_notes: "",
    },
    updateCheckMessage: "",
    isDownloadingUpdate: false,
    downloadProgress: 0,
    updateReady: false,
    activeTaskCount,
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function downloadButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("Download & Install"));
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("UpdateDialog active task guard", () => {
  it("shows the task warning and disables installation while work is running", async () => {
    await mountDialog(2);

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("2");
    expect(downloadButton()?.disabled).toBe(true);
  });

  it("allows installation after all tasks finish", async () => {
    await mountDialog(0);

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(downloadButton()?.disabled).toBe(false);
  });
});
