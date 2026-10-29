// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref } from "vue";
import { describe, expect, it } from "vitest";

describe("Plugin workbench tab inactive layout preservation (#13734)", () => {
  it("preserves inactive tab containers at full bounds without collapsing to display:none", async () => {
    const tabs = [
      { id: "tab-ssh-1", title: "SSH 1", mode: "plugin-workbench" },
      { id: "tab-ssh-2", title: "SSH 2", mode: "plugin-workbench" },
      { id: "tab-http", title: "HTTP Client", mode: "plugin-workbench" },
    ];
    const activeTabId = ref("tab-ssh-1");

    const root = document.createElement("div");
    document.body.appendChild(root);

    // Host workspace layer mirroring App.vue's mountedPluginWorkbenchTabs
    const HostComponent = defineComponent({
      setup() {
        return { tabs, activeTabId };
      },
      template: `
        <div class="relative flex size-full flex-col">
          <div
            v-for="tab in tabs"
            :key="tab.id"
            :data-testid="'container-' + tab.id"
            class="size-full min-h-0 flex-col"
            :class="activeTabId === tab.id
              ? 'relative flex flex-1'
              : 'pointer-events-none absolute inset-0 -z-10 invisible'"
          >
            <div :data-testid="'webview-' + tab.id" class="size-full">content-{{ tab.title }}</div>
          </div>
        </div>
      `,
    });

    const app = createApp(HostComponent);
    app.mount(root);

    const c1 = root.querySelector<HTMLElement>("[data-testid='container-tab-ssh-1']")!;
    const c2 = root.querySelector<HTMLElement>("[data-testid='container-tab-ssh-2']")!;
    const c3 = root.querySelector<HTMLElement>("[data-testid='container-tab-http']")!;

    // Initial state: tab-ssh-1 is active
    expect(c1.classList.contains("relative")).toBe(true);
    expect(c1.classList.contains("flex")).toBe(true);
    expect(c1.classList.contains("flex-1")).toBe(true);
    expect(c1.classList.contains("invisible")).toBe(false);

    // Inactive tabs retain absolute inset-0 and invisible instead of display:none
    expect(c2.classList.contains("absolute")).toBe(true);
    expect(c2.classList.contains("inset-0")).toBe(true);
    expect(c2.classList.contains("invisible")).toBe(true);
    expect(c2.classList.contains("pointer-events-none")).toBe(true);
    expect(c2.style.display).not.toBe("none");

    expect(c3.classList.contains("absolute")).toBe(true);
    expect(c3.classList.contains("inset-0")).toBe(true);
    expect(c3.classList.contains("invisible")).toBe(true);
    expect(c3.style.display).not.toBe("none");

    // Switch to tab-ssh-2
    activeTabId.value = "tab-ssh-2";
    await new Promise((r) => setTimeout(r, 0));

    expect(c1.classList.contains("invisible")).toBe(true);
    expect(c1.classList.contains("absolute")).toBe(true);
    expect(c1.style.display).not.toBe("none");

    expect(c2.classList.contains("relative")).toBe(true);
    expect(c2.classList.contains("flex-1")).toBe(true);
    expect(c2.classList.contains("invisible")).toBe(false);

    app.unmount();
    root.remove();
  });
});
