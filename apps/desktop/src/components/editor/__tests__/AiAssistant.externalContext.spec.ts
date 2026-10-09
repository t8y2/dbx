import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/10058.
//
// The editor's "Send to AI" entry used to paste the selected SQL into the
// composer as prompt text (`setPrompt`) and every external entry resolved its
// target on its own — so the request could run against whatever connection the
// chat happened to hold, and untrusted SQL sat in the instruction channel. The
// rules themselves are unit-tested in
// lib/ai/__tests__/aiConversationBinding.spec.ts and
// lib/ai/__tests__/aiAttachments.spec.ts; this suite pins the wiring, because
// AiAssistant.vue is a large SFC the suite never mounts.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

function bodyOf(fnSignature: string): string {
  const start = source.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in AiAssistant.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${fnSignature}"`);
}

function appBodyOf(fnSignature: string): string {
  const start = appSource.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in App.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = appSource.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < appSource.length; i++) {
    if (appSource[i] === "{") depth++;
    else if (appSource[i] === "}") {
      depth--;
      if (depth === 0) return appSource.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${fnSignature}"`);
}

describe("editor selections reach the AI panel as context (#10058)", () => {
  it("counts a selection as composer context at every enumeration point", () => {
    // Missing any one of the three makes the chip visible while the send button
    // stays disabled, or lets send() drop the selection silently.
    expect(bodyOf("const canSubmitPrompt = computed")).toContain("selectedEditorSelections.value.length");
    expect(bodyOf("async function send()")).toContain("!selectedEditorSelections.value.length");
    expect(source).toContain('v-if="selectedEditorSelections.length"');
    expect(source).toContain("data-ai-selection-chips");
    expect(source).toContain('@click="removeSelectionChip(selection.id)"');
  });

  it("attaches the selection to the request as data, not as prompt text", () => {
    const body = bodyOf("async function send()");

    // The run's model-facing instruction keeps coming from the user's own words.
    expect(body).toContain("userText: text,");
    expect(body).not.toMatch(/buildAiModelInstruction\(\{[\s\S]{0,200}selection/);
    // It travels with the other request context, and with the message so the
    // user can still see what was sent.
    expect(body).toContain("selections: selectionContexts,");
    expect(body).toContain("...(selectionContexts.length ? { selections: selectionContexts } : {})");
    expect(bodyOf("function messageContentForModel")).toContain("formatSelectionDataLines(message.selections || [])");
  });

  it("drops the selection with the rest of the composer context", () => {
    const body = bodyOf("function clearContextReferences()");

    expect(body).toContain("selectedEditorSelections.value = [];");
    // send() clears it alongside the attachments, or the next turn would resend it.
    expect(bodyOf("async function send()")).toContain("selectedEditorSelections.value = [];");
    // Queuing carries text/mode/action only, so — like every other composer
    // context — the selection must not stay behind looking like it was sent.
    expect(bodyOf("function queueInput()")).toContain("selectedEditorSelections.value = [];");
  });

  it("refuses to retarget a background run or a confirmation with the composer's selection", () => {
    const body = bodyOf("async function send()");
    const line = body.split("\n").find((candidate) => candidate.includes("const selectionContexts = ")) ?? "";

    expect(line).toContain("confirmationRetargets");
    expect(line).toContain("? [] :");
  });
});

describe("external AI entries share one target rule (#10058)", () => {
  it("resolves the chat through the shared pure function", () => {
    const body = bodyOf("function openExternalContext(request: AiExternalContextRequest)");

    expect(body).toContain("resolveExternalSendTarget(activeConversation.value, draftBinding.value");
    expect(body).toContain('if (plan.action === "new")');
    expect(body).toContain("clearContextReferences();");
    expect(body).toContain("applyDraftBinding(plan.binding);");
    expect(body).toContain("request.unresolvedKey");
  });

  it("applies the binding before any immediate send", () => {
    // `fixWithAi` runs an action that calls send() synchronously, so an awaited
    // rebind would let the request leave with the previous target.
    const body = bodyOf("function openExternalContext(request: AiExternalContextRequest)");

    expect(body.indexOf("applyDraftBinding(plan.binding);")).toBeLessThan(body.indexOf("if (request.action) triggerAction(request.action, request.instruction);"));
    expect(body).not.toContain("await rebindConversation(");
    expect(source).toContain("openExternalContext,");
  });

  it("routes every external entry in App.vue through the panel's single method", () => {
    expect(appBodyOf("function sendSelectionToAi(tabId: string, sql: string)")).toContain("handle.openExternalContext({");
    expect(appBodyOf("function fixWithAi(tabId: string, errorMessage: string)")).toContain("handle.openExternalContext({");
    expect(appBodyOf("async function addToAi(nodesInput: TreeNode | TreeNode[])")).toContain("handle.openExternalContext({ target: binding, tableMentions });");
    // The old per-entry paths must be gone: pasting the SQL into the composer as
    // the instruction, and retargeting the shown conversation for a tree node.
    expect(appSource).not.toContain("handle.setPrompt(sql)");
    expect(appSource).not.toContain("void handle.bindConversation(binding);");
  });

  it("takes the target from the tab the gesture came from, and degrades when it is gone", () => {
    const body = appBodyOf("function editorAiTarget(tabId?: string): AiConversationBinding | null");

    expect(body).toContain("queryStore.tabs.find((candidate) => candidate.id === tabId)");
    expect(body).toContain("aiTargetFromTab(tab, (connectionId) => !!connectionStore.getConfig(connectionId))");
    // A deleted connection must be reported, never silently kept.
    expect(source).toContain("toast(t(request.unresolvedKey), 5000);");
    expect(appSource).toContain('unresolvedKey: "ai.externalTargetUnavailable"');
    expect(bodyOf("function applyDraftBinding(binding: AiConversationBinding)")).toContain("connectionId: binding.connectionId");
  });

  it("keeps the editor selection entry pointing at the tab that owns the editor", () => {
    expect(appSource).toContain("sendSelectionToAi(activeTab.value.id, selectedSql.value)");
    expect(appSource).toContain("if (tabId === queryStore.activeTabId) sendSelectionToAi(tabId, sql);");
    expect(appSource).toContain("(tabId: string, message: string) => fixWithAi(tabId, message)");
  });
});
