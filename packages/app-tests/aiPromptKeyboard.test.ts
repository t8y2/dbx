import { strict as assert } from "node:assert";
import { test } from "vitest";
import { isAiPromptImeCompositionEvent, shouldSubmitAiPromptOnKeydown } from "../../apps/desktop/src/lib/aiPromptKeyboard.ts";

test("submits AI prompt on plain Enter", () => {
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Enter" }), true);
});

test("does not submit AI prompt while entering a newline", () => {
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Enter", shiftKey: true }), false);
});

test("does not submit AI prompt while IME composition is active", () => {
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Enter" }, true), false);
});

test("does not submit AI prompt for IME composition key events", () => {
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSubmitAiPromptOnKeydown({ key: "Process" }), false);
});

test("detects AI prompt IME composition key events before mention handling", () => {
  assert.equal(isAiPromptImeCompositionEvent({ key: "Enter", isComposing: true }), true);
  assert.equal(isAiPromptImeCompositionEvent({ key: "Enter", keyCode: 229 }), true);
  assert.equal(isAiPromptImeCompositionEvent({ key: "Process" }), true);
  assert.equal(isAiPromptImeCompositionEvent({ key: "Enter" }), false);
});
