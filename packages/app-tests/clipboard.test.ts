import { strict as assert } from "node:assert";
import { test } from "vitest";
import { copyToClipboard, eventTargetAllowsNativeClipboard, hasNativeClipboardSelection, isPlainClipboardShortcut, readTextFromClipboard } from "../../apps/desktop/src/lib/clipboard.ts";

test("copyToClipboard falls back when navigator clipboard is unavailable", async () => {
  const appended: unknown[] = [];
  const removed: unknown[] = [];
  const selected: string[] = [];
  const commands: string[] = [];

  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.style[name] = value;
    },
    select() {
      selected.push(this.value);
    },
  };

  const env = {
    navigator: {},
    document: {
      body: {
        appendChild(node: unknown) {
          appended.push(node);
        },
        removeChild(node: unknown) {
          removed.push(node);
        },
      },
      createElement(tagName: string) {
        assert.equal(tagName, "textarea");
        return textarea;
      },
      execCommand(command: string) {
        commands.push(command);
        return true;
      },
    },
  };

  await copyToClipboard("orders\t42", env);

  assert.deepEqual(selected, ["orders\t42"]);
  assert.deepEqual(commands, ["copy"]);
  assert.equal(appended[0], textarea);
  assert.equal(removed[0], textarea);
});

test("readTextFromClipboard uses navigator clipboard when available", async () => {
  const text = await readTextFromClipboard({
    navigator: {
      clipboard: {
        readText: async () => "orders\t42",
      },
    },
  });

  assert.equal(text, "orders\t42");
});

test("clipboard shortcut detection requires a plain mod shortcut", () => {
  assert.equal(isPlainClipboardShortcut({ key: "C", ctrlKey: true }, "c"), true);
  assert.equal(isPlainClipboardShortcut({ key: "c", metaKey: true }, "c"), true);
  assert.equal(isPlainClipboardShortcut({ key: "c", ctrlKey: true, shiftKey: true }, "c"), false);
  assert.equal(isPlainClipboardShortcut({ key: "c", altKey: true }, "c"), false);
});

test("eventTargetAllowsNativeClipboard lets editable targets keep clipboard shortcuts", () => {
  const inputTarget = {
    closest: (selector: string) => (selector.includes("input") ? {} : null),
  } as unknown as EventTarget;

  assert.equal(eventTargetAllowsNativeClipboard({ key: "v", ctrlKey: true, target: inputTarget }), true);
});

test("hasNativeClipboardSelection detects selections inside one native clipboard region", () => {
  const region = {};
  const element = {
    closest: (selector: string) => (selector === "[data-native-clipboard]" ? region : null),
  };
  const textNode = { parentElement: element } as unknown as Node;

  assert.equal(
    hasNativeClipboardSelection({
      getSelection: () => ({
        anchorNode: textNode,
        focusNode: textNode,
        isCollapsed: false,
      }),
    }),
    true,
  );
});

test("eventTargetAllowsNativeClipboard lets native regions handle copy only with a text selection", () => {
  const region = {};
  const element = {
    closest: (selector: string) => (selector === "[data-native-clipboard]" ? region : null),
  };
  const textNode = { parentElement: element } as unknown as Node;
  const env = {
    getSelection: () => ({
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
    }),
  };

  assert.equal(eventTargetAllowsNativeClipboard({ key: "c", ctrlKey: true }, env), true);
  assert.equal(eventTargetAllowsNativeClipboard({ key: "x", ctrlKey: true }, env), false);
});
