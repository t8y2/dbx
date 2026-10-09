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

describe("DataGridColumnHeader highlight indicator", () => {
  it("does not render highlight indicator when highlightActive is false or omitted", () => {
    const host = mountHeader({ highlightActive: false });
    const indicator = host.querySelector("[data-column-highlight-indicator]");
    expect(indicator).toBeNull();
  });

  it("renders highlight indicator with title and aria-label when highlightActive is true", async () => {
    const host = mountHeader({
      highlightActive: true,
      highlightLabel: "Highlight Active",
    });
    await nextTick();
    const indicator = host.querySelector("[data-column-highlight-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("title")).toBe("Highlight Active");
    expect(indicator?.getAttribute("aria-label")).toBe("Highlight Active");
  });
});
