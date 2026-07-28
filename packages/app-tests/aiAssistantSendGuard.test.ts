import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "vue/compiler-sfc";

// Regression guard for the F2 finding: AiAssistant.send() must acquire the
// synchronous send guard (isGenerating.value = true) BEFORE its first await
// (promptTemplateStore.ensureLoaded()). Otherwise two rapid submissions can
// both pass the initial isGenerating check, await the deferred store load, and
// resume into two concurrent agent runs.
//
// send() is an internal <script setup> function (not exported / not exposed),
// and this repo has no component-mount test harness (@vue/test-utils is not a
// dependency; zero specs call mount()). So — like aiMessageLayout.test.ts — we
// assert the invariant against the SFC source: the guard is set synchronously
// before any suspension point, which is exactly what makes the check-then-set
// sequence atomic against a concurrent caller.

const aiAssistantPath = "apps/desktop/src/components/editor/AiAssistant.vue";
const source = readFileSync(aiAssistantPath, "utf8");

function scriptSetupContent(): string {
  const { descriptor, errors } = parse(source, { filename: aiAssistantPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup, "AiAssistant.vue should use <script setup>");
  return descriptor.scriptSetup!.content;
}

// Extract a function body by brace-matching from a signature anchor, so the
// assertions below are scoped to send() and immune to unrelated edits elsewhere
// in the (very large) component.
function functionBody(script: string, signature: string): string {
  const sigIndex = script.indexOf(signature);
  assert.notEqual(sigIndex, -1, `expected to find ${signature}`);
  assert.equal(
    script.indexOf(signature, sigIndex + signature.length),
    -1,
    `${signature} should be unique`,
  );
  const openBrace = script.indexOf("{", sigIndex + signature.length);
  assert.notEqual(openBrace, -1, "function body should open with a brace");

  let depth = 0;
  for (let i = openBrace; i < script.length; i++) {
    const ch = script[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return script.slice(openBrace + 1, i);
    }
  }
  throw new Error("unbalanced braces while extracting function body");
}

test("send() acquires the guard synchronously before the first await", () => {
  const body = functionBody(scriptSetupContent(), "async function send()");

  const entryCheck = body.search(/\|\|\s*isGenerating\.value\)\s*return/);
  const guardSet = body.indexOf("isGenerating.value = true");
  const firstAwait = body.indexOf("await");

  assert.notEqual(entryCheck, -1, "send() should early-return when isGenerating is already set");
  assert.notEqual(guardSet, -1, "send() should set the isGenerating guard");
  assert.notEqual(firstAwait, -1, "send() should contain an await");

  // The entry check runs first, then the guard is set, then (and only then) the
  // first await suspends. Because nothing awaits between the check and the set,
  // a second concurrent send() cannot slip past the check before the guard flips.
  assert.ok(entryCheck < guardSet, "isGenerating check must precede the guard set");
  assert.ok(guardSet < firstAwait, "guard must be set before the first await (no await between check and set)");

  // The first suspension point is specifically the prompt-template load — the
  // await the reviewer flagged as happening before the guard existed.
  const ensureLoadedAwait = body.indexOf("await promptTemplateStore.ensureLoaded()");
  assert.notEqual(ensureLoadedAwait, -1, "send() should await promptTemplateStore.ensureLoaded()");
  assert.equal(firstAwait, ensureLoadedAwait, "ensureLoaded() must be the first await in send()");
});

test("send() never leaks the guard on an early return after acquiring it", () => {
  const body = functionBody(scriptSetupContent(), "async function send()");
  const guardSet = body.indexOf("isGenerating.value = true");

  // Every `return` that appears after the guard is acquired must first reset the
  // guard (there is one such path: the ensureLoaded() failure branch). A bare
  // `return` after the guard without a reset would strand isGenerating at true
  // and permanently block all future sends.
  const tail = body.slice(guardSet);
  const returnsAfterGuard = [...tail.matchAll(/\breturn\b/g)];
  assert.ok(returnsAfterGuard.length >= 1, "expected the ensureLoaded failure branch to early-return");

  for (const match of returnsAfterGuard) {
    const preceding = tail.slice(0, match.index);
    assert.ok(
      preceding.includes("isGenerating.value = false"),
      "any early return after the guard is acquired must reset isGenerating first",
    );
  }
});

test("send() snapshots custom prompts before deferred AI context loading", () => {
  const body = functionBody(scriptSetupContent(), "async function send()");
  const ensureLoadedAwait = body.indexOf("await promptTemplateStore.ensureLoaded()");
  const snapshot = body.indexOf("const customPromptContext: CustomPromptContext");
  const sqlFileLoad = body.indexOf("await loadReferencedSqlFiles");
  const aiContextLoad = body.indexOf("await buildAiContext");

  assert.notEqual(snapshot, -1, "send() should snapshot the custom prompt context");
  assert.ok(ensureLoadedAwait < snapshot, "the snapshot must be taken after templates finish loading");
  assert.ok(snapshot < sqlFileLoad, "SQL file loading must not delay the custom prompt snapshot");
  assert.ok(snapshot < aiContextLoad, "AI context loading must not delay the custom prompt snapshot");
  assert.match(body.slice(snapshot, sqlFileLoad), /activeTemplates:\s*\[\.\.\.activeTemplates\.value\]/);
});
