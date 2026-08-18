import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";

const aiAssistantPath = "apps/desktop/src/components/editor/AiAssistant.vue";
const source = readFileSync(aiAssistantPath, "utf8");

function userMessageTemplate(): string {
  const start = source.indexOf(`<div v-if="msg.role === 'user'"`);
  const end = source.indexOf(`<div v-else-if="msg.content || msg.reasoning || msg.isThinking"`, start);

  assert.notEqual(start, -1, "user message template should exist");
  assert.notEqual(end, -1, "assistant message template should follow user messages");
  return source.slice(start, end);
}

function assistantMessageTemplate(): string {
  const start = source.indexOf(`<div v-else-if="msg.content || msg.reasoning || msg.isThinking"`);
  const end = source.indexOf(`</template>`, start);

  assert.notEqual(start, -1, "assistant message template should exist");
  assert.notEqual(end, -1, "assistant message template should end before the message loop");
  return source.slice(start, end);
}

test("AI assistant template compiles", () => {
  const { descriptor, errors } = parse(source, { filename: aiAssistantPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.template);

  const result = compileTemplate({ id: aiAssistantPath, filename: aiAssistantPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
});

test("user message edit action does not change short or wrapped message layout", () => {
  const template = userMessageTemplate();

  assert.match(template, /class="relative min-w-0 max-w-\[85%\]"/);
  assert.match(template, /class="min-w-0"/);
  assert.match(template, /absolute right-full top-1 mr-1 flex h-5 w-5/);
  assert.match(template, /class="whitespace-pre-wrap"/);
  assert.doesNotMatch(template, /\bhidden\b[^\n>]*group-hover:flex/);
});

test("user message edit action remains available by pointer and keyboard", () => {
  const template = userMessageTemplate();

  assert.match(template, /group-hover:pointer-events-auto group-hover:opacity-100/);
  assert.match(template, /focus:pointer-events-auto focus:opacity-100/);
  assert.match(template, /:title="t\('ai\.editMessage'\)"[\s\S]*?@click="startEditMessage\(i\)"/);
  assert.match(template, /v-if="!isGenerating"/);
});

test("assistant messages keep metadata aligned with the bubble and wrap long text", () => {
  const template = assistantMessageTemplate();

  assert.match(template, /class="flex w-full max-w-\[95%\] min-w-0 flex-col"/);
  assert.match(template, /class="w-full[^"\n]*\[overflow-wrap:anywhere\]"/);
});

test("AI request failures use localized backend diagnostics", () => {
  // The lookup is guarded (matching the `finally` block right below it) so that if
  // clearMessages()/selectConversation() already replaced messages.value while this
  // request was still in flight, writing the failure text doesn't throw and silently
  // swallow the real error. See issue #5941.
  assert.match(source, /const msg = messages\.value\[assistantIdx\];\s*\n\s*if \(msg\) msg\.content = `\$\{t\("ai\.requestFailed"\)\}\\n\\n\$\{translateBackendError\(t, message\)\}`;/);
});

test("AI analysis export keeps the connection that produced each assistant response", () => {
  assert.match(source, /sourceConnectionName\?: string/);
  assert.match(source, /messages\.value\.push\(\{ role: "assistant", content: "", sourceConnectionName: connection\.name \}\)/);
  assert.match(source, /connectionName: msg\.sourceConnectionName \?\? props\.connection\?\.name/);
  assert.match(source, /sourceConnectionName: m\.role === "assistant" \? conv\.connectionName : undefined/);
});
