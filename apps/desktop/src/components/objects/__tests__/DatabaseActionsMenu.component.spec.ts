// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import DatabaseActionsMenu from "../DatabaseActionsMenu.vue";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ mounted: vi.fn(), build: vi.fn(), action: vi.fn() }));
vi.mock("vue-i18n", async (importOriginal) => ({ ...(await importOriginal<typeof import("vue-i18n")>()), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/sidebar/SidebarTreeRuntimeHost.vue", () => ({
  default: defineComponent({
    setup(_, { expose }) {
      mocks.mounted();
      expose({ buildContextMenu: mocks.build });
      return () => null;
    },
  }),
}));
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    DropdownMenu: defineComponent({
      emits: ["update:open"],
      setup:
        (_, { slots, emit }) =>
        () =>
          h("div", [h("button", { "data-open": "", onClick: () => emit("update:open", true) }, "open"), slots.default?.()]),
    }),
    DropdownMenuContent: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuSeparator: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuItem: defineComponent({
      emits: ["select"],
      setup:
        (_, { slots, emit }) =>
        () =>
          h("button", { "data-action": "", onClick: () => emit("select") }, slots.default?.()),
    }),
  };
});

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("mounts the runtime only on demand and makes actions available on the first opening", async () => {
  mocks.build.mockReturnValue([{ label: "common.more", children: [{ label: "databaseDrop.menu", action: mocks.action }] }]);
  const root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(DatabaseActionsMenu, { connection: { id: "mysql-1", db_type: "mysql" } as ConnectionConfig, database: "app" });
  app.mount(root);
  await nextTick();
  expect(mocks.mounted).not.toHaveBeenCalled();
  root.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await nextTick();
  await nextTick();
  expect(mocks.mounted).toHaveBeenCalledTimes(1);
  expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "mysql-1", database: "app", type: "database" }));
  const action = root.querySelector<HTMLButtonElement>("[data-action]")!;
  expect(action.textContent).toContain("databaseDrop.menu");
  action.click();
  expect(mocks.action).toHaveBeenCalledTimes(1);
  root.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await nextTick();
  expect(mocks.mounted).toHaveBeenCalledTimes(1);
});
