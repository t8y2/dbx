import { strict as assert } from "node:assert";
import { test, vi } from "vitest";
import { copyToClipboard, eventTargetAllowsAppClipboardShortcut, eventTargetAllowsNativeClipboard, eventTargetUsesNativeClipboard, hasNativeClipboardSelection, isPlainClipboardShortcut, readTextFromClipboard, type ClipboardEnvironment } from "../../apps/desktop/src/lib/common/clipboard.ts";

const tauriClipboardMock = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => tauriClipboardMock);

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

test("copyToClipboard falls back to navigator clipboard after a Tauri write failure", async () => {
  const webWrite = vi.fn(async () => undefined);
  const legacyCopy = vi.fn(() => true);
  tauriClipboardMock.writeText.mockRejectedValueOnce(new Error("native clipboard unavailable"));

  await copyToClipboard("INSERT INTO users VALUES (1);", {
    __TAURI_INTERNALS__: {},
    navigator: { clipboard: { writeText: webWrite } },
    document: {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn(),
      execCommand: legacyCopy,
    },
  } as unknown as ClipboardEnvironment & Record<string, unknown>);

  assert.deepEqual(webWrite.mock.calls, [["INSERT INTO users VALUES (1);"]]);
  assert.equal(legacyCopy.mock.calls.length, 0);
});

test("copyToClipboard falls back to legacy copy after Tauri and navigator failures", async () => {
  const selected: string[] = [];
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select() {
      selected.push(this.value);
    },
  };
  const webWrite = vi.fn(async () => {
    throw new Error("web clipboard unavailable");
  });
  const legacyCopy = vi.fn(() => true);
  tauriClipboardMock.writeText.mockRejectedValueOnce(new Error("native clipboard unavailable"));

  await copyToClipboard("INSERT INTO users VALUES (2);", {
    __TAURI_INTERNALS__: {},
    navigator: { clipboard: { writeText: webWrite } },
    document: {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn(() => textarea),
      execCommand: legacyCopy,
    },
  } as unknown as ClipboardEnvironment & Record<string, unknown>);

  assert.deepEqual(webWrite.mock.calls, [["INSERT INTO users VALUES (2);"]]);
  assert.deepEqual(selected, ["INSERT INTO users VALUES (2);"]);
  assert.deepEqual(legacyCopy.mock.calls, [["copy"]]);
});

test("copyToClipboard does not fall back after a successful Tauri write", async () => {
  const webWrite = vi.fn(async () => undefined);
  const legacyCopy = vi.fn(() => true);
  tauriClipboardMock.writeText.mockResolvedValueOnce(undefined);

  await copyToClipboard("INSERT INTO users VALUES (3);", {
    __TAURI_INTERNALS__: {},
    navigator: { clipboard: { writeText: webWrite } },
    document: {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn(),
      execCommand: legacyCopy,
    },
  } as unknown as ClipboardEnvironment & Record<string, unknown>);

  assert.deepEqual(tauriClipboardMock.writeText.mock.calls.at(-1), ["INSERT INTO users VALUES (3);"]);
  assert.equal(webWrite.mock.calls.length, 0);
  assert.equal(legacyCopy.mock.calls.length, 0);
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
  assert.equal(eventTargetUsesNativeClipboard({ target: inputTarget }), true);
});

test("eventTargetAllowsAppClipboardShortcut ignores editable targets only", () => {
  const inputTarget = {
    closest: (selector: string) => (selector.includes("input") ? {} : null),
  } as unknown as EventTarget;
  const buttonTarget = {
    closest: () => null,
  } as unknown as EventTarget;

  assert.equal(eventTargetAllowsAppClipboardShortcut({ key: "v", ctrlKey: true, target: inputTarget }), false);
  assert.equal(eventTargetAllowsAppClipboardShortcut({ key: "v", ctrlKey: true, target: buttonTarget }), true);
  assert.equal(eventTargetAllowsAppClipboardShortcut({ key: "v", ctrlKey: true, shiftKey: true, target: buttonTarget }), false);
  assert.equal(eventTargetAllowsAppClipboardShortcut({ key: "c", metaKey: true, target: buttonTarget }, "c"), true);
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
