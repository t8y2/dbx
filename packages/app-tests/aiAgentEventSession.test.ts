import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const tauriBackendSource = readFileSync("apps/desktop/src/lib/backend/tauri.ts", "utf8");
const tauriAiCommandSource = readFileSync("src-tauri/src/commands/ai.rs", "utf8");

test("Tauri AI agent stream events carry their session id", () => {
  assert.match(tauriAiCommandSource, /struct AiAgentEventPayload \{/);
  assert.match(tauriAiCommandSource, /session_id: String/);
  assert.match(tauriAiCommandSource, /#\[serde\(flatten\)\]\s*event: AgentEvent/);
  assert.match(tauriAiCommandSource, /let event_session_id = session_id\.clone\(\);/);
  assert.match(tauriAiCommandSource, /AiAgentEventPayload \{ session_id: event_session_id\.clone\(\), event \}/);
  assert.match(tauriAiCommandSource, /app\.emit\("ai-agent-event", &payload\)/);
});

test("frontend ignores AI agent stream events from other sessions", () => {
  assert.match(tauriBackendSource, /type TauriAgentEvent = AgentEvent & \{\s*session_id\?: string;\s*\};/);
  assert.match(tauriBackendSource, /listen<TauriAgentEvent>\("ai-agent-event"/);
  assert.match(tauriBackendSource, /if \(payload\.session_id && payload\.session_id !== sessionId\) return;/);
  assert.match(tauriBackendSource, /onEvent\(payload\);/);
});
