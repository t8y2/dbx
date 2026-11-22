// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DataGridRowJsonPreview from "../DataGridRowJsonPreview.vue";

const fields = [
  {
    columnIndex: 0,
    column: "payload",
    value: { user: { name: "Alice" } },
    text: '  "payload": {\n    "user": {\n      "name": "Alice"\n    }\n  }',
    comment: "payload comment",
    isTruncated: false,
  },
];

function mountPreview() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      render: () => h(DataGridRowJsonPreview, { fields, previewHint: (count: number) => `preview:${count}` }),
    }),
  );
  app.mount(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DataGridRowJsonPreview", () => {
  it("collapses a nested container and renumbers the visible lines", async () => {
    const host = mountPreview();
    await nextTick();

    const root = host.querySelector(".font-mono");
    const toggle = root?.querySelector<HTMLButtonElement>("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(root?.textContent).toContain('"name": "Alice"');

    toggle?.click();
    await nextTick();

    const collapsedToggle = root?.querySelector<HTMLButtonElement>("button");
    expect(collapsedToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(root?.textContent).not.toContain('"name": "Alice"');
    expect(root?.textContent).toContain('"payload": {…}');
    expect([...root!.querySelectorAll("span")].map((span) => span.textContent).filter((text) => /^\d+$/.test(text ?? ""))).toEqual(["1", "2", "3"]);
  });
});
