// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard, type ClipboardEnvironment } from "@/lib/common/clipboard";

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function legacyEnvironment(execCommand = vi.fn(() => true)): ClipboardEnvironment {
  return {
    document: {
      body: document.body,
      get activeElement() {
        return document.activeElement ?? undefined;
      },
      createElement: (tag) => document.createElement(tag),
      getSelection: () => document.getSelection(),
      execCommand,
    },
  };
}

const outcomes = ["success", "rejected", "throws"] as const;

function finishCopy(outcome: (typeof outcomes)[number]): boolean {
  if (outcome === "throws") throw new Error("copy command failed");
  return outcome === "success";
}

async function expectCopyOutcome(copy: Promise<void>, outcome: (typeof outcomes)[number]) {
  if (outcome === "success") await expect(copy).resolves.toBeUndefined();
  else await expect(copy).rejects.toThrow(outcome === "throws" ? "copy command failed" : "Clipboard copy failed");
}

describe("legacy clipboard focus restoration", () => {
  it.each(outcomes.flatMap((outcome) => (["input", "textarea"] as const).map((tag) => ({ outcome, tag }))))("restores $tag focus and backward selection after $outcome", async ({ outcome, tag }) => {
    const input = document.createElement(tag);
    input.value = "SELECT value FROM data";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(2, 12, "backward");
    const focus = vi.spyOn(input, "focus");
    const execCommand = vi.fn(() => {
      expect(document.activeElement).not.toBe(input);
      expect((document.activeElement as HTMLTextAreaElement).value).toBe("copied result");
      return finishCopy(outcome);
    });

    await expectCopyOutcome(copyToClipboard("copied result", legacyEnvironment(execCommand)), outcome);

    expect(document.activeElement).toBe(input);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 12, "backward"]);
    expect(document.body.children).toHaveLength(1);
  });

  it.each(outcomes)("restores contenteditable focus and backward DOM selection after %s", async (outcome) => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.textContent = "SELECT value FROM data";
    document.body.appendChild(editor);
    editor.focus();
    const content = editor.firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(content, 12, content, 2);
    const execCommand = vi.fn(() => {
      // The legacy copy command temporarily replaces the browser selection.
      selection.collapse(document.body, 0);
      return finishCopy(outcome);
    });

    await expectCopyOutcome(copyToClipboard("copied result", legacyEnvironment(execCommand)), outcome);

    expect(document.activeElement).toBe(editor);
    expect(selection.anchorNode).toBe(content);
    expect(selection.focusNode).toBe(content);
    expect([selection.anchorOffset, selection.focusOffset]).toEqual([12, 2]);
    expect(selection.toString()).toBe("LECT value");
    expect(document.body.children).toHaveLength(1);
  });

  it("cleans up when no element was focused and no DOM selection existed", async () => {
    document.getSelection()?.removeAllRanges();

    await copyToClipboard("copied result", legacyEnvironment());

    expect(document.activeElement).toBe(document.body);
    expect(document.body.children).toHaveLength(0);
    expect(document.getSelection()?.rangeCount).toBe(0);
  });

  it("keeps the input focused when restoring a DOM selection focuses its contenteditable owner", async () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.textContent = "SELECT value";
    const input = document.createElement("input");
    input.value = "search";
    document.body.append(editor, input);
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(editor.firstChild!, 0, editor.firstChild!, 6);
    input.focus();
    input.setSelectionRange(1, 4);
    const setBaseAndExtent = selection.setBaseAndExtent.bind(selection);
    vi.spyOn(selection, "setBaseAndExtent").mockImplementation((...args) => {
      setBaseAndExtent(...args);
      // Browsers may focus a contenteditable when its DOM selection is restored.
      editor.focus();
    });

    await copyToClipboard("copied result", legacyEnvironment());

    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(selection.toString()).toBe("SELECT");
  });

  it("restores the current focus when an asynchronous Web Clipboard failure starts the fallback", async () => {
    const first = document.createElement("input");
    const current = document.createElement("textarea");
    current.value = "current editor";
    document.body.append(first, current);
    first.focus();
    let rejectWrite!: (error: Error) => void;
    const writeText = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectWrite = reject)));
    const env = legacyEnvironment();
    env.navigator = { clipboard: { writeText } };
    const copy = copyToClipboard("copied result", env);

    current.focus();
    current.setSelectionRange(1, 7, "forward");
    rejectWrite(new Error("permission denied"));
    await copy;

    expect(document.activeElement).toBe(current);
    expect([current.selectionStart, current.selectionEnd, current.selectionDirection]).toEqual([1, 7, "forward"]);
  });

  it("does not touch focus or selection when Web Clipboard succeeds", async () => {
    const input = document.createElement("input");
    input.value = "existing selection";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(2, 5);
    const focus = vi.spyOn(input, "focus");
    const execCommand = vi.fn(() => true);
    const env = legacyEnvironment(execCommand);
    env.navigator = { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } };

    await copyToClipboard("copied result", env);

    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(focus).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });
});
