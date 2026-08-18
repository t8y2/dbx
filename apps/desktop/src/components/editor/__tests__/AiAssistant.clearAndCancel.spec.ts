import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/5941 and the follow-up
// race identified on https://github.com/t8y2/dbx/pull/6332:
//
// When an in-flight AI request is stuck (e.g. a hung MCP tool call / slow provider
// response), clicking the clear-chat trash icon, "New Chat", deleting the active
// conversation, or switching to a different saved conversation must (a) cancel the
// in-flight request so `isGenerating` doesn't stay stranded true forever, and (b)
// isolate that in-flight request's async event callbacks / catch / finally from
// whatever conversation is active by the time they run — even if the backend cancel
// RPC itself is a no-op because the request hadn't registered a session id yet.
//
// (b) is what `AiGenerationGuard` (lib/ai/aiGenerationGuard.ts) exists for. Its own
// spec and aiConversationLifecycle.spec.ts exercise the async ordering directly;
// this file pins that AiAssistant.vue wires those tested lifecycle helpers into the
// component paths that own the shared state.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

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

describe("AI assistant clear/switch cancels an in-flight request (issue #5941, PR #6332)", () => {
  it("abandonInFlightRequest() invalidates the generation guard before/regardless of the backend RPC", () => {
    const body = bodyOf("function abandonInFlightRequest(alreadyCancelledSessionId?: string)");
    expect(body).toContain("aiGenerationGuard.invalidate();");
    expect(body).toContain("isGenerating.value = false;");
    expect(body).toContain('currentSessionId.value = "";');
    // Invalidation (and resetting isGenerating/currentSessionId/delta buffers) must
    // happen unconditionally and before the best-effort backend RPC, so a send()
    // that hasn't registered a session id yet is still cut off from shared state.
    expect(body.indexOf("aiGenerationGuard.invalidate();")).toBeLessThan(body.indexOf("if (sessionId && sessionId !== alreadyCancelledSessionId) {"));
  });

  it("clearMessages() abandons a stuck stream before wiping history", () => {
    const body = bodyOf("function clearMessages()");
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    // The abandon guard must run before the history is actually wiped, not after.
    expect(body.indexOf("if (isGenerating.value) abandonInFlightRequest();")).toBeLessThan(body.indexOf("messages.value = []"));
  });

  it("selectConversation() abandons a stuck stream before switching conversations", () => {
    const body = bodyOf("function selectConversation(conv: AiConversation)");
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    expect(body.indexOf("if (isGenerating.value) abandonInFlightRequest();")).toBeLessThan(body.indexOf("conversationId.value = conv.id;"));
  });

  it("cancelStream() delegates live state readers to the tested stop lifecycle", () => {
    const body = bodyOf("async function cancelStream()");
    expect(body).toContain("await stopAiGenerationWithFallback({");
    expect(body).toContain("currentGeneration: () => aiGenerationGuard.peek()");
    expect(body).toContain("currentAssistantMessageIndex: () => currentAssistantMessageIndex");
    expect(body).toContain("abandon: (sessionId) => abandonInFlightRequest(sessionId)");
    expect(body).toContain("persistConversation,");
  });

  it("startNewChat() clears through the guarded path and deleteConversation() uses the tested delete lifecycle", () => {
    expect(bodyOf("function startNewChat()")).toContain("clearMessages();");
    const deleteBody = bodyOf("async function deleteConversation(id: string)");
    expect(deleteBody).toContain("await deleteConversationWithCancellation({");
    expect(deleteBody).toContain("abandon: () => abandonInFlightRequest()");
    expect(deleteBody).toContain("deletePersisted: () => deleteAiConversation(id).catch(() => {})");
    expect(deleteBody).toContain("if (conversationId.value === id) clearMessages();");
  });

  it("send() claims a generation id right after setting isGenerating and re-checks it after the first await", () => {
    const sendBody = bodyOf("async function send()");
    const claimIdx = sendBody.indexOf("const myGeneration = aiGenerationGuard.begin();");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(sendBody.indexOf("isGenerating.value = true;")).toBeLessThan(claimIdx);
    // Must re-validate after the first await point (ensureLoaded()) before doing
    // anything that touches messages/mentions belonging to whatever conversation
    // is current by the time it resolves.
    const ensureLoadedAwaitIdx = sendBody.indexOf("await promptTemplateStore.ensureLoaded()");
    const recheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration))", ensureLoadedAwaitIdx);
    expect(ensureLoadedAwaitIdx).toBeGreaterThan(claimIdx);
    expect(recheckIdx).toBeGreaterThan(ensureLoadedAwaitIdx);
  });

  it("send() clears the pending write-SQL grant when superseded before it's consumed", () => {
    // Reviewed on PR #6332: at this point in send(), the write-SQL grant
    // (allowWriteSqlForNextRun/confirmedWriteSqlText/...) hasn't been read/reset
    // yet — that happens later, right before runAgentStream(). A bare `return`
    // here would leave a previously-confirmed write grant sitting in the
    // module-scope vars, live to be replayed against whatever unrelated send()
    // the next conversation issues.
    const sendBody = bodyOf("async function send()");
    const ensureLoadedAwaitIdx = sendBody.indexOf("await promptTemplateStore.ensureLoaded()");
    const grantConsumedIdx = sendBody.indexOf("const allowWriteSql = requestedMode", ensureLoadedAwaitIdx);
    const recheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) {", ensureLoadedAwaitIdx);
    expect(recheckIdx).toBeGreaterThan(ensureLoadedAwaitIdx);
    expect(recheckIdx).toBeLessThan(grantConsumedIdx);
    const recheckEnd = sendBody.indexOf("}", recheckIdx);
    const recheckBlock = sendBody.slice(recheckIdx, recheckEnd);
    expect(recheckBlock).toContain("clearPendingWriteGrant();");
    expect(recheckBlock).toContain("return;");
  });

  it("send()'s agent-event callback bails immediately if superseded", () => {
    const sendBody = bodyOf("async function send()");
    const callbackStart = sendBody.indexOf("(event: AgentEvent) => {");
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    const guardIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", callbackStart);
    const pushIdx = sendBody.indexOf("agentEvents.push(event);", callbackStart);
    expect(guardIdx).toBeGreaterThan(callbackStart);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it("send()'s catch block guards the assistant message lookup behind the generation check", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} catch (e: unknown) {");
    expect(start, 'expected to find a "} catch (e: unknown) {" block inside send()').toBeGreaterThanOrEqual(0);
    const end = sendBody.indexOf("} finally {", start);
    const catchBody = sendBody.slice(start, end);
    // Must not index messages.value[assistantIdx] unguarded — if clearMessages()/
    // selectConversation() already replaced the array (or invalidated the
    // generation) while this request was still in flight, an unguarded write would
    // either throw (silently eating the real error) or corrupt a different
    // conversation's transcript.
    expect(catchBody).not.toContain("messages.value[assistantIdx].content =");
    expect(catchBody).toContain("aiGenerationGuard.isCurrent(myGeneration)");
    expect(catchBody).toContain("const msg = messages.value[assistantIdx];");
    expect(catchBody).toContain("if (msg) msg.content =");
  });

  it("send()'s finally block only mutates shared state (isGenerating, currentSessionId) when still current", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} finally {");
    expect(start).toBeGreaterThanOrEqual(0);
    const finallyBody = sendBody.slice(start);
    const guardIdx = finallyBody.indexOf("if (aiGenerationGuard.isCurrent(myGeneration)) {");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const isGeneratingIdx = finallyBody.indexOf("isGenerating.value = false;");
    const sessionResetIdx = finallyBody.indexOf('currentSessionId.value = "";');
    expect(isGeneratingIdx).toBeGreaterThan(guardIdx);
    expect(sessionResetIdx).toBeGreaterThan(guardIdx);
  });

  // The three gaps below were called out on review of PR #6332: the generation guard
  // stopped *writes* from a superseded generation, but didn't stop the generation from
  // starting a stream, leaking pending-compaction state, or from surviving unmount.
  it("send() rechecks the generation after EACH context-preparation await, before ever starting the stream", () => {
    const sendBody = bodyOf("async function send()");
    const sqlFilesIdx = sendBody.indexOf("await loadReferencedSqlFiles(");
    const firstRecheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", sqlFilesIdx);
    const contextIdx = sendBody.indexOf("const context = await buildAiContext(");
    const secondRecheckIdx = sendBody.indexOf("if (!aiGenerationGuard.isCurrent(myGeneration)) return;", contextIdx);
    const runIdx = sendBody.indexOf("await runAgentStream(", contextIdx);
    // A clear/switch/unmount firing during EITHER await invalidates the generation
    // but doesn't touch the backend (no session registered yet) — without a
    // recheck immediately after each one, send() would resume into further wasted
    // work (buildAiContext() can do real backend/schema work) and eventually call
    // runAgentStream() anyway, starting a request nobody can reach anymore.
    expect(sqlFilesIdx).toBeGreaterThanOrEqual(0);
    expect(firstRecheckIdx).toBeGreaterThan(sqlFilesIdx);
    expect(firstRecheckIdx).toBeLessThan(contextIdx);
    expect(secondRecheckIdx).toBeGreaterThan(contextIdx);
    expect(runIdx).toBeGreaterThan(secondRecheckIdx);
  });

  it("send() tracks the current assistant message index alongside currentSessionId, for cancelStream() to finalize", () => {
    // cancelStream()'s forced-abandon path needs to know which message in
    // messages.value belongs to this generation so it can finalize it (see the
    // "finalizes the stuck placeholder message" test above). Must be set at the
    // same point currentSessionId is, and cleared alongside it too.
    const sendBody = bodyOf("async function send()");
    const pushIdx = sendBody.indexOf('messages.value.push({ role: "assistant"');
    const assistantIdxIdx = sendBody.indexOf("const assistantIdx = messages.value.length - 1;", pushIdx);
    const trackIdx = sendBody.indexOf("currentAssistantMessageIndex = assistantIdx;", assistantIdxIdx);
    const sessionSetIdx = sendBody.indexOf("currentSessionId.value = sessionId;", trackIdx);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdxIdx).toBeGreaterThan(pushIdx);
    expect(trackIdx).toBeGreaterThan(assistantIdxIdx);
    expect(sessionSetIdx).toBeGreaterThan(trackIdx);

    const start = sendBody.indexOf("} finally {");
    const finallyBody = sendBody.slice(start);
    const sessionResetIdx = finallyBody.indexOf('currentSessionId.value = "";');
    const indexResetIdx = finallyBody.indexOf("currentAssistantMessageIndex = -1;");
    expect(sessionResetIdx).toBeGreaterThanOrEqual(0);
    expect(indexResetIdx).toBeGreaterThan(sessionResetIdx);
  });

  it("abandonInFlightRequest() skips the cancel RPC for a session the caller already cancelled", () => {
    // Reviewed on PR #6332 (efficiency): cancelStream() awaits aiCancelStream()
    // itself before deciding to force-abandon, so re-firing it unconditionally
    // here would double-RPC the same session. Must still fire for a session
    // registered AFTER the caller's own RPC attempt (i.e. not simply skipped
    // whenever a caller happened to pass an argument).
    const body = bodyOf("function abandonInFlightRequest(alreadyCancelledSessionId?: string)");
    expect(body).toContain("if (sessionId && sessionId !== alreadyCancelledSessionId) {");
    expect(body).not.toContain("if (sessionId) {\n    aiCancelStream(sessionId).catch(() => {});\n  }");
  });

  it("resetPendingRequestState() resets all per-request transient state, and abandonInFlightRequest() uses it", () => {
    // Reviewed on PR #6332: this reset logic used to be duplicated inline across
    // send()'s finally, abandonInFlightRequest(), and flushAssistantDeltas() —
    // duplication that already let the pendingCompaction reset get missed once.
    // Consolidating it into one function means a newly-added piece of per-request
    // state only needs to be added here to be covered by the abandon path.
    const resetBody = bodyOf("function resetPendingRequestState()");
    expect(resetBody).toContain("cancelAnimationFrame(assistantDeltaFrame);");
    expect(resetBody).toContain("assistantDeltaFrame = null;");
    expect(resetBody).toContain('pendingAssistantDelta = "";');
    expect(resetBody).toContain('pendingAssistantReasoning = "";');
    expect(resetBody).toContain("pendingAssistantIndex = -1;");
    // A context_compacted event on the abandoned generation may have already set
    // pendingCompaction before invalidation took effect. It's request-owned, not
    // conversation-owned, so it must be reset here — otherwise the next send() (in
    // a brand-new, just-cleared conversation) would splice the OLD conversation's
    // compaction summary into the NEW conversation's transcript in its finally
    // block.
    expect(resetBody).toContain("pendingCompaction.value = null;");

    const abandonBody = bodyOf("function abandonInFlightRequest(alreadyCancelledSessionId?: string)");
    expect(abandonBody).toContain("resetPendingRequestState();");
  });

  it("onUnmounted() invalidates the generation instead of only firing the best-effort cancel RPC", () => {
    const body = bodyOf("onUnmounted(() => {");
    // Plain cancelStream() leaves the generation current: a request still mid-await
    // when the component unmounts would resume, call runAgentStream(), and its event
    // callback/catch/finally would keep writing into refs this now-unmounted
    // instance's closures still hold. Must go through the same invalidating path as
    // clearMessages()/selectConversation().
    expect(body).toContain("if (isGenerating.value) abandonInFlightRequest();");
    expect(body).not.toContain("cancelStream();");
  });
});
