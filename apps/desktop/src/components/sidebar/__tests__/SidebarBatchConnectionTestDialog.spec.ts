// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SidebarBatchConnectionTestDialog from "../SidebarBatchConnectionTestDialog.vue";

const backend = vi.hoisted(() => ({
  config: { id: "db", name: "Test database", host: "original.example" },
  test: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/backend/api", () => ({ testConnectionWithInfo: backend.test }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => backend.config }) }));

it("marks a result as skipped when the connection changes during the test", async () => {
  let finish!: () => void;
  backend.test.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({ setup: () => () => h(SidebarBatchConnectionTestDialog, { connectionIds: ["db"] }) }));
  app.use(i18n);
  app.mount(host);
  try {
    await nextTick();
    expect(backend.test).toHaveBeenCalledTimes(1);
    backend.config = { ...backend.config, host: "updated.example" };
    finish();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Not tested"));
    expect(document.body.textContent).not.toContain("Connection successful");
  } finally {
    app.unmount();
    host.remove();
  }
});
