// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DataGridColumnHeader from "../DataGridColumnHeader.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountHeader(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render() {
      return h(DataGridColumnHeader, {
        actualColumnIndex: 0,
        visibleColumnIndex: 0,
        name: "test_col",
        type: "VARCHAR",
        width: 120,
        isSorted: false,
        sortMode: null,
        copyColumnNameLabel: "Copy",
        columnNameLabel: "Column",
        columnTypeLabel: "Type",
        columnCommentLabel: "Comment",
        columnSourceLabel: "Source",
        columnIndexLabel: "Index",
        columnPrimaryIndexLabel: "PK",
        columnUniqueIndexLabel: "Unique",
        columnRegularIndexLabel: "Regular",
        ...props,
      });
    },
  });
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
});

describe("DataGridColumnHeader filter indicator", () => {
  it("does not render the filter indicator when filterActive is false or omitted", () => {
    const host = mountHeader({ filterActive: false });
    expect(host.querySelector("[data-column-filter-indicator]")).toBeNull();
  });

  it("renders the filter indicator with title and aria-label when filterActive is true", async () => {
    const host = mountHeader({ filterActive: true, filterLabel: "Filtered" });
    await nextTick();
    const indicator = host.querySelector("[data-column-filter-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("title")).toBe("Filtered");
    expect(indicator?.getAttribute("aria-label")).toBe("Filtered");
  });
});
