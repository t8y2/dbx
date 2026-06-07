import { strict as assert } from "node:assert";
import test from "node:test";
import { copyToClipboard, readTextFromClipboard } from "../../apps/desktop/src/lib/clipboard.ts";

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
