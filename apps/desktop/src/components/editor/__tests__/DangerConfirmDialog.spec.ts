// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { copyToClipboard } from "@/lib/common/clipboard";

const DANGER_PREVIEW_MAX_CHARACTERS = 8192;
const DANGER_PREVIEW_MAX_LINES = 200;
const highlight = vi.fn((sql: string) => `<span>${sql}</span>`);
const focusMocks = vi.hoisted(() => {
  const focus = vi.fn();
  return {
    focus,
    findFromDOM: vi.fn(() => ({ focus })),
  };
});

vi.mock("@codemirror/view", () => ({
  EditorView: { findFromDOM: focusMocks.findFromDOM },
}));

vi.mock("@/composables/useSqlHighlighter", () => ({
  useSqlHighlighter: () => ({ highlight }),
}));

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

const mountedApps: App[] = [];

async function mountDialog(sql: string, extraProps: Record<string, unknown> = {}, listeners: Record<string, (...args: any[]) => void> = {}, previewSlot?: () => ReturnType<typeof h>) {
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          DangerConfirmDialog,
          {
            open: state.open,
            sql,
            ...extraProps,
            ...listeners,
            "onUpdate:open": (value: boolean) => {
              state.open = value;
            },
          },
          previewSlot ? { preview: previewSlot } : undefined,
        ),
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
  focusMocks.findFromDOM.mockClear();
  focusMocks.focus.mockClear();
});

describe("DangerConfirmDialog SQL preview", () => {
  it("hosts editable review in the existing confirmation and keeps its final action disabled until validation", async () => {
    const confirmed = vi.fn();
    const draft = reactive({ sql: "CREATE PACKAGE P AS END;" });
    await mountDialog(draft.sql, { confirmDisabled: true, closeOnConfirm: false, confirmLabel: "Start reviewed transfer" }, { onConfirm: confirmed }, () =>
      h("textarea", {
        value: draft.sql,
        onInput: (event: Event) => {
          draft.sql = (event.target as HTMLTextAreaElement).value;
        },
      }),
    );
    expect(document.body.querySelector('[data-testid="danger-code-preview"]')).toBeNull();
    const input = document.body.querySelector("textarea")!;
    input.value = "CREATE PACKAGE P AS n NUMBER; END;";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect(draft.sql).toContain("n NUMBER");
    const confirm = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Start reviewed transfer")!;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(confirmed).not.toHaveBeenCalled();
  });

  it("starts optional details collapsed and keeps the complete SQL available to copy", async () => {
    const sql = "CREATE TABLE target (id NUMBER);";
    await mountDialog(sql, { detailsLabel: "View SQL" });
    const details = document.body.querySelector<HTMLDetailsElement>("details[data-testid='danger-code-container']");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("summary")?.textContent).toBe("View SQL");
    details!.open = true;
    details!.querySelector<HTMLButtonElement>('button[title="Copy full text"]')!.click();
    await nextTick();
    expect(copyToClipboard).toHaveBeenCalledWith(sql);
  });

  it("lets a result caller hide Cancel and settle confirmation before closing", async () => {
    const confirmed = vi.fn();
    await mountDialog("CREATE TABLE target (id NUMBER);", { showCancel: false, closeOnConfirm: false, confirmLabel: "Close result" }, { onConfirm: confirmed });
    const buttons = Array.from(document.body.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent?.trim() === "Cancel")).toBe(false);
    buttons.find((button) => button.textContent?.trim() === "Close result")!.click();
    await nextTick();
    expect(confirmed).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

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

  it("builds lazy full SQL only when the copy action is used", async () => {
    const fullSql = "DELETE FROM orders;\nDELETE FROM customers;";
    const getCopySql = vi.fn(() => fullSql);

    await mountDialog("DELETE FROM orders;", { copySql: getCopySql });
    expect(getCopySql).not.toHaveBeenCalled();

    const copyButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.title === "Copy full text");
    copyButton?.click();
    await nextTick();

    expect(getCopySql).toHaveBeenCalledOnce();
    expect(copyToClipboard).toHaveBeenCalledWith(fullSql);
  });

  it("restores a previously focused CodeMirror editor through EditorView on close", async () => {
    const editorRoot = document.createElement("div");
    editorRoot.className = "cm-editor";
    const editorContent = document.createElement("div");
    editorContent.className = "cm-content";
    editorContent.tabIndex = 0;
    editorRoot.append(editorContent);
    document.body.append(editorRoot);
    editorContent.focus();

    await mountDialog("DROP TABLE users;");
    const cancelButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Cancel");
    cancelButton?.click();

    await vi.waitFor(() => {
      expect(focusMocks.findFromDOM).toHaveBeenCalledWith(editorRoot);
    });
    expect(focusMocks.focus).toHaveBeenCalledOnce();
  });
});

describe("DangerConfirmDialog running/cancel footer state", () => {
  function footerButtons() {
    const footer = document.body.querySelectorAll("button");
    return Array.from(footer);
  }

  it("keeps the default Cancel button unchanged when cancelable is not set (existing callers)", async () => {
    await mountDialog("DROP TABLE users;", { loading: true });

    const buttons = footerButtons();
    const cancelButton = buttons.find((button) => button.textContent?.trim() === "Cancel");
    expect(cancelButton).toBeDefined();
    expect(cancelButton?.disabled).toBe(true);
    expect(buttons.some((button) => button.textContent?.trim() === "Cancel Query")).toBe(false);
  });

  it("shows an active Cancel Query button while loading when cancelable is true", async () => {
    const onCancelRunning = vi.fn();
    await mountDialog("DELETE FROM big_orders;", { loading: true, cancelable: true }, { onCancelRunning });

    const buttons = footerButtons();
    const cancelRunningButton = buttons.find((button) => button.textContent?.trim() === "Cancel Query");
    expect(cancelRunningButton).toBeDefined();
    expect(cancelRunningButton?.disabled).toBe(false);

    cancelRunningButton?.click();
    await nextTick();

    expect(onCancelRunning).toHaveBeenCalledOnce();
  });

  it("disables the Cancel Query button while the cancel itself is in flight", async () => {
    await mountDialog("DELETE FROM big_orders;", { loading: true, cancelable: true, cancelRunningLoading: true });

    const buttons = footerButtons();
    const cancelRunningButton = buttons.find((button) => button.textContent?.trim() === "Cancel Query");
    expect(cancelRunningButton?.disabled).toBe(true);
  });

  it("does not show the Cancel Query button when cancelable is true but not loading", async () => {
    await mountDialog("DELETE FROM big_orders;", { loading: false, cancelable: true });

    const buttons = footerButtons();
    expect(buttons.some((button) => button.textContent?.trim() === "Cancel Query")).toBe(false);
    expect(buttons.some((button) => button.textContent?.trim() === "Cancel")).toBe(true);
  });
});
