// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { copyToClipboard } from "@/lib/common/clipboard";

const DANGER_PREVIEW_MAX_CHARACTERS = 8192;
const DANGER_PREVIEW_MAX_LINES = 200;
const highlight = vi.fn((sql: string) => `<span>${sql}</span>`);

vi.mock("@/composables/useSqlHighlighter", () => ({
  useSqlHighlighter: () => ({ highlight }),
}));

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

const mountedApps: App[] = [];

async function mountDialog(sql: string) {
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(DangerConfirmDialog, {
          open: state.open,
          sql,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  highlight.mockClear();
  vi.mocked(copyToClipboard).mockClear();
});

describe("DangerConfirmDialog SQL preview", () => {
  it("wraps SQL by default, including long unbroken identifiers", async () => {
    await mountDialog(`UPDATE ${"very_long_identifier_".repeat(20)} SET value = 1;`);

    const container = document.body.querySelector('[data-testid="danger-code-container"]');
    const preview = container?.querySelector('[data-testid="danger-code-preview"]');
    const code = preview?.querySelector("pre");
    expect(code?.classList).toContain("whitespace-pre-wrap");
    expect(code?.classList).toContain("break-all");
    expect(preview?.classList).toContain("overflow-auto");
    const actions = container?.querySelector('[data-testid="danger-code-actions"]');
    expect(actions?.classList).toContain("justify-end");
    expect(actions?.nextElementSibling).toBe(preview);
    expect(actions?.classList).not.toContain("absolute");

    actions?.querySelectorAll("button")[1]?.click();
    await nextTick();

    expect(code?.classList).toContain("whitespace-pre");
    expect(code?.classList).toContain("w-max");
    expect(code?.classList).toContain("min-w-full");
  });

  it("fully highlights short SQL without a truncation notice", async () => {
    const sql = "DROP TABLE IF EXISTS users;";

    await mountDialog(sql);

    expect(highlight).toHaveBeenCalledOnce();
    expect(highlight).toHaveBeenCalledWith(sql);
    expect(document.body.querySelector('[data-testid="danger-preview-truncated"]')).toBeNull();
  });

  it("highlights only bounded head and tail fragments for huge SQL", async () => {
    const sql = Array.from({ length: 40_000 }, (_, index) => `INSERT INTO t VALUES (${index});`).join("\n");

    await mountDialog(sql);

    const highlightedCharacters = highlight.mock.calls.reduce((total, [fragment]) => total + fragment.length, 0);
    expect(highlight).toHaveBeenCalledTimes(2);
    expect(highlightedCharacters).toBeLessThanOrEqual(DANGER_PREVIEW_MAX_CHARACTERS);
    expect(highlight.mock.calls.flatMap(([fragment]) => fragment.split("\n"))).toHaveLength(DANGER_PREVIEW_MAX_LINES);
    expect(document.body.querySelector('[data-testid="danger-preview-truncated"]')?.textContent).toContain("Preview truncated");
  });

  it("copies the full SQL instead of the bounded preview", async () => {
    const sql = Array.from({ length: 40_000 }, (_, index) => `INSERT INTO t VALUES (${index});`).join("\n");

    await mountDialog(sql);
    const copyButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.title === "Copy full text");
    copyButton?.click();
    await nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith(sql);
  });
});
