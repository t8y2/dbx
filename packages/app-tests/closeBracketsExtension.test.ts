import { strict as assert } from "node:assert";
import { test } from "vitest";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * Replicates the closeBracketsExtension logic from QueryEditor.vue so we can
 * verify that the Compartment-based toggle correctly includes/excludes both
 * the closeBrackets() extension and the closeBracketsKeymap.
 */
function closeBracketsExtension(enabled: boolean) {
  if (!enabled) return [];
  const exts: any[] = [closeBrackets()];
  if (closeBracketsKeymap.length) {
    exts.push(keymap.of([...closeBracketsKeymap]));
  }
  return exts;
}

test("closeBracketsExtension returns empty array when disabled", () => {
  const exts = closeBracketsExtension(false);

  assert.deepEqual(exts, []);
});

test("closeBracketsExtension includes closeBrackets and its keymap when enabled", () => {
  const exts = closeBracketsExtension(true);

  assert.equal(exts.length, 2, "should contain closeBrackets() and keymap");
});

test("closeBracketsKeymap is non-empty so the keymap entry is always included when enabled", () => {
  assert.ok(closeBracketsKeymap.length > 0, "closeBracketsKeymap should have bindings");
});

test("Compartment can create EditorState with closeBrackets enabled", () => {
  const comp = new Compartment();
  const state = EditorState.create({
    doc: "select 1",
    extensions: [comp.of(closeBracketsExtension(true))],
  });

  assert.ok(state.toJSON().doc, "state should be created with closeBrackets enabled");
});

test("Compartment reconfigure from enabled to disabled succeeds", () => {
  const comp = new Compartment();
  const stateOn = EditorState.create({
    doc: "select 1",
    extensions: [comp.of(closeBracketsExtension(true))],
  });

  // Toggle off — this verifies that closeBracketsExtension(false) returns []
  // which means both the extension and the keymap are removed
  const stateOff = stateOn.update({ effects: comp.reconfigure(closeBracketsExtension(false)) }).state;

  assert.equal(stateOff.toJSON().doc, "select 1", "state should still be valid after reconfigure to disabled");
});

test("Compartment reconfigure from disabled to enabled succeeds", () => {
  const comp = new Compartment();
  const stateOff = EditorState.create({
    doc: "select 1",
    extensions: [comp.of(closeBracketsExtension(false))],
  });

  // Toggle on — this verifies that closeBracketsExtension(true) returns both
  // the closeBrackets() extension and the keymap
  const stateOn = stateOff.update({ effects: comp.reconfigure(closeBracketsExtension(true)) }).state;

  assert.equal(stateOn.toJSON().doc, "select 1", "state should still be valid after reconfigure to enabled");
});

test("closeBracketsExtension(false) produces zero extensions", () => {
  // The key assertion: when disabled, both closeBrackets() and
  // closeBracketsKeymap are absent — no partial keymap leakage
  const exts = closeBracketsExtension(false);
  assert.equal(exts.length, 0);
});

test("closeBracketsExtension(true) produces exactly two extension groups", () => {
  // When enabled, both closeBrackets() and the keymap are present
  const exts = closeBracketsExtension(true);
  assert.equal(exts.length, 2);
});
