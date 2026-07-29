import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const aiAssistantPath = fileURLToPath(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url));
const aiAssistantSource = readFileSync(aiAssistantPath, "utf8");

test("AI mode resets to Ask for a new conversation and panel remount", () => {
  assert.match(aiAssistantSource, /const assistantMode = ref<AiAssistantMode>\("ask"\)/);
  assert.doesNotMatch(aiAssistantSource, /"update:mode"/);

  const start = aiAssistantSource.indexOf("function startNewChat()");
  const end = aiAssistantSource.indexOf("\nonMounted", start);
  const startNewChat = aiAssistantSource.slice(start, end);
  assert.match(startNewChat, /assistantMode\.value = "ask"/);
  assert.match(startNewChat, /activeAction\.value = resolveDefaultAction\("ask"\)/);
});

test("AI mode tab click resets the active action even when mode is unchanged", () => {
  const start = aiAssistantSource.indexOf('function switchModeActionTab(mode: "ask" | "agent")');
  const end = aiAssistantSource.indexOf("\nfunction selectModeActionItem", start);
  const switchModeActionTab = aiAssistantSource.slice(start, end);

  assert.notEqual(start, -1, "switchModeActionTab should exist");
  assert.notEqual(end, -1, "selectModeActionItem should follow switchModeActionTab");
  assert.doesNotMatch(switchModeActionTab, /if\s*\(\s*assistantMode\.value\s*===\s*mode\s*\)\s*(?:\{\s*)?return/);

  const defaultActionReset = switchModeActionTab.indexOf("activeAction.value = resolveDefaultAction(mode)");
  const modeChangeGuard = switchModeActionTab.indexOf("if (assistantMode.value !== mode)");
  assert.notEqual(defaultActionReset, -1, "mode tab clicks should reset to the mode default action");
  assert.notEqual(modeChangeGuard, -1, "mode assignment should still be guarded when unchanged");
  assert.ok(defaultActionReset < modeChangeGuard, "default action reset should run before same-mode guard");
});
