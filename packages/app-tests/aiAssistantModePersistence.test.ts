import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const aiAssistantPath = fileURLToPath(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url));
const aiAssistantSource = readFileSync(aiAssistantPath, "utf8");

test("AI mode initializes from the persisted default mode", () => {
  // The fallback value is still Ask, but the panel syncs from the configured default.
  assert.match(aiAssistantSource, /const assistantMode = ref<AiAssistantMode>\("ask"\)/);
  assert.match(aiAssistantSource, /settings\.defaultAiMode/);
  assert.doesNotMatch(aiAssistantSource, /"update:mode"/);

  // The persisted setting is applied once after the asynchronous config load;
  // later setting changes must not alter an active conversation.
  assert.match(aiAssistantSource, /watch\([\s\S]*?settings\.isAiConfigLoaded[\s\S]*?defaultModeInitialized/);
  assert.match(aiAssistantSource, /assistantMode\.value = settings\.defaultAiMode/);
});

test("startNewChat uses the configured default mode instead of a hardcoded Ask reset", () => {
  const start = aiAssistantSource.indexOf("function startNewChat()");
  const end = aiAssistantSource.indexOf("\nonMounted", start);
  const startNewChat = aiAssistantSource.slice(start, end);

  assert.notEqual(start, -1, "startNewChat should exist");
  assert.match(startNewChat, /const mode = settings\.defaultAiMode/);
  assert.match(startNewChat, /assistantMode\.value = mode/);
  assert.match(startNewChat, /activeAction\.value = resolveDefaultAction\(mode\)/);
  // The old hardcoded Ask reset must be gone.
  assert.doesNotMatch(startNewChat, /assistantMode\.value = "ask"/);
});

test("switching mode in a session never touches the global default setting", () => {
  const start = aiAssistantSource.indexOf('function switchModeActionTab(mode: "ask" | "agent")');
  const end = aiAssistantSource.indexOf("\nfunction selectModeActionItem", start);
  const switchModeActionTab = aiAssistantSource.slice(start, end);

  assert.notEqual(start, -1, "switchModeActionTab should exist");
  assert.notEqual(end, -1, "selectModeActionItem should follow switchModeActionTab");
  // Session switch updates local state only — no store write.
  assert.doesNotMatch(switchModeActionTab, /setDefaultAiMode|setAiAssistantDefaultMode/);
  assert.doesNotMatch(switchModeActionTab, /if\s*\(\s*assistantMode\.value\s*===\s*mode\s*\)\s*(?:\{\s*)?return/);

  const defaultActionReset = switchModeActionTab.indexOf("activeAction.value = resolveDefaultAction(mode)");
  const modeChangeGuard = switchModeActionTab.indexOf("if (assistantMode.value !== mode)");
  assert.notEqual(defaultActionReset, -1, "mode tab clicks should reset to the mode default action");
  assert.notEqual(modeChangeGuard, -1, "mode assignment should still be guarded when unchanged");
  assert.ok(defaultActionReset < modeChangeGuard, "default action reset should run before same-mode guard");
});
