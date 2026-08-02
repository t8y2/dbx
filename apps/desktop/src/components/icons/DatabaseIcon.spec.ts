// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DatabaseIcon from "./DatabaseIcon.vue";

describe("DatabaseIcon", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the OceanBase asset for Oracle mode", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon, { dbType: "oceanbase-oracle" });
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/database/oceanbase.svg");
    app.unmount();
  });
});
