// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import FunctionDictionaryPanel from "@/components/layout/FunctionDictionaryPanel.vue";
import type { ConnectionConfig } from "@/types/database";

function connection(dbType: ConnectionConfig["db_type"], name = "Test connection"): ConnectionConfig {
  return {
    id: "connection-1",
    name,
    db_type: dbType,
  } as ConnectionConfig;
}

const mountedApps: App[] = [];

async function mountPanel(connection?: ConnectionConfig): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(FunctionDictionaryPanel, { connection }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return container;
}

function setSearchText(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`Search input was not rendered: ${container.innerHTML}`);
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("FunctionDictionaryPanel", () => {
  it("renders the ClickHouse dictionary with group filters and searchable signatures", async () => {
    const container = await mountPanel(connection("clickhouse"));

    const chips = [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(chips.some((label) => label.includes("Conversion"))).toBe(true);
    expect(container.textContent).toContain("Function Dictionary");

    setSearchText(container, "toInt32");
    await nextTick();
    expect(container.textContent).toContain("toInt32(argument, ...arguments)");
    expect(container.textContent).not.toContain("cityHash64");
  });

  it("shows the localized empty state for database types without dictionary data", async () => {
    const container = await mountPanel(connection("elasticsearch"));
    expect(container.textContent).toContain("elasticsearch");
    expect(container.textContent).toMatch(/No built-in function data/i);
  });

  it("prompts for a connection when none is active", async () => {
    const container = await mountPanel(undefined);
    expect(container.textContent).toMatch(/Open a query tab with a connection/i);
  });
});
