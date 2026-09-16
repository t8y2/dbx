// @vitest-environment happy-dom

import { createApp, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import RoutineMetadataPanel from "@/components/objects/RoutineMetadataPanel.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("RoutineMetadataPanel", () => {
  it("renders parameter modes, defaults, and a function return type", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(RoutineMetadataPanel, {
      returnType: "NUMERIC(12,3)",
      parameters: [
        { name: "p_amount", dataType: "NUMERIC(10,2)", mode: "IN", ordinal: 1, hasDefault: false },
        { name: "p_rate", dataType: "NUMERIC(5,2)", mode: "INOUT", ordinal: 2, hasDefault: true, defaultValue: "0.10" },
        { name: "p_status", dataType: "VARCHAR(20)", mode: "OUT", ordinal: 3, hasDefault: false },
      ],
    });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    expect(host.querySelector("[data-routine-return-type]")?.textContent).toContain("NUMERIC(12,3)");
    const rows = [...host.querySelectorAll("[data-routine-parameter]")];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("p_amount");
    expect(rows[1].textContent).toContain("INOUT");
    expect(rows[1].textContent).toContain("0.10");
    expect(rows[2].textContent).toContain("OUT");
  });

  it("shows return metadata without rendering an empty parameter table", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(RoutineMetadataPanel, { returnType: "INTEGER", parameters: [] });
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    expect(host.querySelector("[data-routine-return-type]")?.textContent).toContain("INTEGER");
    expect(host.querySelectorAll("[data-routine-parameter]")).toHaveLength(0);
  });
});
