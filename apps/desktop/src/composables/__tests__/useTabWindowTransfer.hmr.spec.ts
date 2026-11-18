// @vitest-environment happy-dom
import { createApp, defineComponent, h, inject, provide } from "vue";
import { expect, it, vi } from "vitest";
import type { QueryTab } from "@/types/database";

it("keeps an existing workspace coordinator available after a consumer module reload", async () => {
  const original = await import("../useTabWindowTransfer");
  vi.resetModules();
  const updated = await import("../useTabWindowTransfer");
  const tab = { id: "query", mode: "query", title: "Query", sql: "SELECT 1", connectionId: "pg", database: "app", isExecuting: false } satisfies QueryTab;
  const openTabInNewWindow = vi.fn();
  const coordinator = { openTabInNewWindow } as unknown as ReturnType<typeof original.useTabWindowTransfer>;
  const consumer = defineComponent({
    setup() {
      const transfer = inject(updated.TAB_WINDOW_TRANSFER, null);
      return () => h("button", { onClick: () => transfer?.openTabInNewWindow(tab) }, "Open in new window");
    },
  });
  const app = createApp({
    setup() {
      provide(original.TAB_WINDOW_TRANSFER, coordinator);
      return () => h(consumer);
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  try {
    app.mount(host);
    host.querySelector("button")!.click();
    expect(openTabInNewWindow).toHaveBeenCalledExactlyOnceWith(tab);
  } finally {
    app.unmount();
    host.remove();
  }
});
