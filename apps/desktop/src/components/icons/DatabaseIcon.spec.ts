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

  it("uses the Apache Phoenix asset for the Phoenix JDBC profile", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon, { dbType: "phoenix" });
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/database/phoenix.svg");
    app.unmount();
  });

  it("uses the Meilisearch asset", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon, { dbType: "meilisearch" });
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/database/meilisearch.svg");
    app.unmount();
  });

  it("falls back to the generic icon when the database type is missing", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon);
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    app.unmount();
  });
});
