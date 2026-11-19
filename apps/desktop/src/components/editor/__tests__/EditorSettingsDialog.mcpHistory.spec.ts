// @vitest-environment happy-dom

import { compile, createApp, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { History } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import dialogSource from "../EditorSettingsDialog.vue?raw";

// Mount the actual transport header with real tabs/buttons, without loading
// the unrelated settings editors or calling backend services.
const start = dialogSource.indexOf('<Tabs v-model="mcpTransportTab"');
const end = dialogSource.indexOf('<TabsContent value="http"', start);
if (start < 0 || end < 0) throw new Error("MCP transport header was not found");
const template = `${dialogSource.slice(start, end)}<TabsContent value="stdio">stdio</TabsContent><TabsContent value="http">HTTP</TabsContent></Tabs>`;
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((unmount) => unmount()));

describe("MCP transport header", () => {
  it.each([
    ["en", en.settings],
    ["zh-CN", zhCN.settings],
  ])("keeps the history action available in both transports with an accessible name in %s", async (_locale, messages) => {
    const settings = messages as Record<string, string>;
    const mcpTransportTab = ref("stdio");
    const requestMcpCallHistory = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp({
      components: { Tabs, TabsContent, TabsList, TabsTrigger, Button, History },
      setup: () => ({ mcpTransportTab, requestMcpCallHistory, t: (key: string) => settings[key.replace("settings.", "")] }),
      render: compile(template),
    });
    app.mount(root);
    cleanup.push(() => {
      app.unmount();
      root.remove();
    });
    await nextTick();
    const history = root.querySelector<HTMLButtonElement>("[data-mcp-open-call-history]")!;
    expect(root.querySelectorAll("[data-mcp-open-call-history]")).toHaveLength(1);
    expect(history.getAttribute("aria-label")).toBe(settings.mcpOpenCallHistory);
    expect(history.title).toBe(settings.mcpOpenCallHistory);
    expect(history.closest('[role="tablist"]')).toBeNull();
    history.click();
    expect(requestMcpCallHistory).toHaveBeenCalledOnce();
    expect(mcpTransportTab.value).toBe("stdio");
    root.querySelector<HTMLButtonElement>('[role="tab"][id$="-http"]')!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    await nextTick();
    expect(mcpTransportTab.value).toBe("http");
    await vi.waitFor(() => expect(root.querySelector('[role="tabpanel"][data-state="active"]')!.textContent).toBe("HTTP"));
    history.click();
    expect(requestMcpCallHistory).toHaveBeenCalledTimes(2);
    expect(mcpTransportTab.value).toBe("http");
  });
});
