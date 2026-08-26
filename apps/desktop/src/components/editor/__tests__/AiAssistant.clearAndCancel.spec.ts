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

describe("AI assistant uses platform-specific conversation lifecycle", () => {
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

  it("clearMessages() keeps Web cancellation while Desktop detaches the view", () => {
    const body = bodyOf("function clearMessages()");
    expect(body).toContain("if (isGenerating.value && !backgroundAiRunsEnabled) abandonInFlightRequest();");
    expect(body).toContain("if (isGenerating.value && backgroundAiRunsEnabled) void persistConversation();");
    // The abandon guard must run before the history is actually wiped, not after.
    expect(body.indexOf("!backgroundAiRunsEnabled) abandonInFlightRequest();")).toBeLessThan(body.indexOf("messages.value = []"));
  });

  it("selectConversation() cancels on Web and reattaches to a Desktop run", () => {
    const body = bodyOf("function selectConversation(conv: AiConversation)");
    expect(body).toContain("if (isGenerating.value && !backgroundAiRunsEnabled) abandonInFlightRequest();");
    expect(body).toContain("desktopAiRun<ChatMessage>(conv.id)");
    expect(body.indexOf("!backgroundAiRunsEnabled) abandonInFlightRequest();")).toBeLessThan(body.indexOf("conversationId.value = conv.id;"));
  });

  it("cancelStream() delegates live state readers to the tested stop lifecycle", () => {
    const body = bodyOf("async function cancelStream()");
    expect(body).toContain("await stopAiGenerationWithFallback({");
    expect(body).toContain("currentGeneration: () => aiGenerationGuard.peek()");
    expect(body).toContain("currentAssistantMessageIndex: () => currentAssistantMessageIndex");
    expect(body).toContain("abandon: (sessionId) => abandonInFlightRequest(sessionId)");
    expect(body).toContain("persistConversation,");
  });

  it("startNewChat() clears through the guarded path and performDeleteConversation() uses the tested delete lifecycle", () => {
    expect(bodyOf("function startNewChat()")).toContain("clearMessages();");
    const deleteBody = bodyOf("async function performDeleteConversation(id: string)");
    expect(deleteBody).toContain("await deleteConversationWithCancellation({");
    expect(deleteBody).toContain("abandon: () => abandonInFlightRequest()");
    expect(deleteBody).toContain("deletePersisted: () => deleteAiConversation(id).catch(() => {})");
    expect(deleteBody).toContain("if (conversationId.value === id) clearMessages();");
  });

  it("deleteConversation() asks for confirmation only when the conversation owns an active task", () => {
    // Parent PRD §4 line 70: deleting a conversation with a running/queued/
    // awaiting task must first ask; a conversation without an active task still
    // deletes directly.
    const deleteBody = bodyOf("async function deleteConversation(id: string)");
    expect(deleteBody).toContain("if (backgroundAiRunsEnabled && conversationHasActiveTask(id)) {");
    expect(deleteBody).toContain("deleteConfirmConversationId.value = id;");
    expect(deleteBody).toContain("await performDeleteConversation(id);");
    const taskBody = bodyOf("function conversationHasActiveTask(id: string)");
    expect(taskBody).toContain('status === "awaiting_write_confirmation"');
    expect(taskBody).toContain('status === "pending_recoverable"');
  });

  it("performDeleteConversation() marks desktop runs discardOnFinish so no async write can resurrect them", () => {
    // Reviewed finding (delete-resurrection, HIGH): a queued/running background
    // run's snapshot persists fired AFTER deleteAiConversation committed, so the
    // INSERT OR REPLACE recreated the just-deleted conversation. The delete path
    // must flag the run so every persist site skips it.
    const body = bodyOf("async function performDeleteConversation(id: string)");
    expect(body).toContain("run.discardOnFinish = true;");
    expect(body).toContain('if (run.status === "queued") cancelQueuedDesktopAiRun(run);');
    // The run is never finished here: the delete removes it from the registry
    // immediately and the bounded background cleanup owns finalization, so a
    // finished-but-still-slot-holding run can't wedge the queue.
    expect(body).not.toContain('finishDesktopAiRun(run, "cancelled");');
    expect(body).toContain("releaseDeletedRunSlot(run);");
    // The confirm path must cancel runs in ALL active statuses, including a
    // pending write confirmation and a recovered draft.
    expect(body).toContain('run.status === "awaiting_write_confirmation"');
    expect(body).toContain('run.status === "pending_recoverable"');
  });

  it("performDeleteConversation() launches bounded slot release so a deleted-but-hung run cannot wedge the queue", () => {
    // Reviewed finding (slot leak, HIGH): the delete path removed the run from
    // the registry immediately but never released its admittedRunIds slot when
    // the backend stream was hung — after DESKTOP_AI_CONCURRENCY_LIMIT such
    // deletes the global queue wedges permanently. The bounded release waits
    // for the pipeline's settled signal (or the force-abandon deadline) and
    // frees the slot; it also must not block the delete on the cancel RPC.
    const releaseBody = bodyOf("function releaseDeletedRunSlot(run: DesktopAiRunRuntime<ChatMessage>)");
    expect(releaseBody).toContain("if (!run.settled) return;");
    expect(releaseBody).toContain("waitForDesktopRunSettled(run)");
    expect(releaseBody).toContain("releaseDesktopAiRunSlot(run.runId)");
    expect(releaseBody).toContain("requestDesktopRunCancellation(run, deadlineAt, false)");
    const deleteBody = bodyOf("async function performDeleteConversation(id: string)");
    expect(deleteBody).not.toContain("await aiCancelStream(");
  });

  it("send() guards every snapshot persist behind discardOnFinish so a deleted conversation can't be resurrected", () => {
    const sendBody = bodyOf("async function send()");
    // All three send()-internal persist sites (queued persist, unslotted
    // early-return, and the pre-stream snapshot) must be guarded — previously
    // some persisted unconditionally.
    const guardedSites = sendBody.match(/if \(!detachedRun\.discardOnFinish\) void runSnapshotScheduler\.save\(detachedRun\);/g) ?? [];
    expect(guardedSites.length).toBe(3);
    // The finally must skip the run snapshot when the run was deleted, and the
    // Web-only conversation fallback must not fire for a deleted Desktop run.
    const finallyIdx = sendBody.indexOf("} finally {");
    const finallyBody = sendBody.slice(finallyIdx);
    expect(finallyBody).toContain("if (!detachedRun.discardOnFinish) {");
    expect(finallyBody).not.toContain("else void persistConversationSnapshot(");
  });

  it("send() tags a queued run's FIFO category so restart recovery can classify it", () => {
    const sendBody = bodyOf("async function send()");
    const queueIdx = sendBody.indexOf('if (detachedRun.status === "queued")');
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    const queuedBlock = sendBody.slice(queueIdx);
    expect(queuedBlock).toContain('fifoCategory: resumingConfirmedWrite ? "write_confirmation_resume" : "normal_send"');
    expect(queuedBlock).toContain("pendingInput: resumingConfirmedWrite ? detachedRun.pendingInput : text");
  });

  it("send() discards a recovered pending-input run before starting a fresh one", () => {
    const sendBody = bodyOf("async function send()");
    const registerIdx = sendBody.indexOf("const resumableRun = desktopAiRun<ChatMessage>(runConversationId);");
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    const registerBlock = sendBody.slice(registerIdx);
    expect(registerBlock).toContain('resumableRun?.status === "pending_recoverable"');
    expect(registerBlock).toContain("resumableRun.discardOnFinish = true;");
    expect(registerBlock).toContain("removeDesktopAiRun(resumableRun.conversationId);");
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
    const recheckIdx = sendBody.indexOf("if (!generationCanContinue())", ensureLoadedAwaitIdx);
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
    const recheckIdx = sendBody.indexOf("if (!generationCanContinue()) {", ensureLoadedAwaitIdx);
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
    const guardIdx = sendBody.indexOf("if (!generationCanContinue()) return;", callbackStart);
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
    expect(catchBody).toContain("generationCanContinue()");
    expect(catchBody).toContain("const msg = runMessages[assistantIdx];");
    expect(catchBody).toContain("if (msg) msg.content =");
  });

  it("send()'s finally block only mutates shared state (isGenerating, currentSessionId) when still current", () => {
    const sendBody = bodyOf("async function send()");
    const start = sendBody.indexOf("} finally {");
    expect(start).toBeGreaterThanOrEqual(0);
    const finallyBody = sendBody.slice(start);
    const guardIdx = finallyBody.indexOf("if (detachedRun || aiGenerationGuard.isCurrent(myGeneration)) {");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const isGeneratingIdx = finallyBody.indexOf("isGenerating.value = false;");
    const sessionResetIdx = finallyBody.indexOf('currentSessionId.value = "";');
    expect(isGeneratingIdx).toBeGreaterThan(guardIdx);
    expect(sessionResetIdx).toBeGreaterThan(guardIdx);
    // Issue #6743 feature 1 dual-path reset: the normal-completion path must stop
    // the 1s status timer and clear the generation-status ref inside the guarded
    // finally (the abandon path clears it via resetPendingRequestState()).
    expect(finallyBody.indexOf("stopStatusTimer();")).toBeGreaterThan(guardIdx);
    expect(finallyBody.indexOf("generationStatus.value = createGenerationStatus(Date.now());")).toBeGreaterThan(guardIdx);
  });

  it("the generation-status line exposes a screen-reader live region (role=status) that excludes ticking numerals", () => {
    // Issue #6743 feature 1 a11y: async execution-state updates must be
    // announced. The status block (data-ai-generation-status) must contain a
    // role="status" live region fed by `statusLiveAnnouncement` — which, unlike
    // the visible `statusText`, omits the per-second elapsed/idle numerals so a
    // screen reader hears discrete state changes, not a timer ticking every 1s.
    const statusBlockStart = source.indexOf("data-ai-generation-status");
    expect(statusBlockStart).toBeGreaterThanOrEqual(0);
    const block = source.slice(statusBlockStart);
    expect(block).toContain('role="status"');
    expect(block).toContain('aria-live="polite"');
    expect(block).toContain('aria-atomic="true"');
    expect(block).toContain("statusLiveAnnouncement");
    expect(block).toContain('class="sr-only"');
  });

  it("the generation-status line hides once the generation is finished (agent_end) even before isGenerating clears", () => {
    // Issue #6743 fix: agent_end/error arrive via the event callback before
    // runAgentStream()'s promise resolves (CLI teardown / SSE close can take
    // seconds), so the status line must ALSO be gated on phase !== 'finished' —
    // otherwise it lingers below the completed reply showing a reset "0s".
    const statusLineIdx = source.indexOf("data-ai-generation-status");
    expect(statusLineIdx).toBeGreaterThanOrEqual(0);
    const lineStart = source.lastIndexOf("\n", statusLineIdx) + 1;
    const lineEnd = source.indexOf("\n", statusLineIdx);
    const openingTag = source.slice(lineStart, lineEnd);
    expect(openingTag).toContain("generationStatus.phase !== 'finished'");
    expect(openingTag).toContain("data-ai-generation-status");
  });

  it("the >60s long-running hint is hidden once the generation is finished", () => {
    // Fix keeps startedAt on the finished phase, so the hint must not reappear
    // under a completed reply during the isGenerating-still-true gap.
    const idx = source.indexOf("const statusLongRunningHintVisible");
    expect(idx).toBeGreaterThanOrEqual(0);
    const line = source.slice(idx, source.indexOf("\n", idx));
    expect(line).toContain('"finished"');
  });

  // The three gaps below were called out on review of PR #6332: the generation guard
  // stopped *writes* from a superseded generation, but didn't stop the generation from
  // starting a stream, leaking pending-compaction state, or from surviving unmount.
  it("send() rechecks the generation after EACH context-preparation await, before ever starting the stream", () => {
    const sendBody = bodyOf("async function send()");
    const sqlFilesIdx = sendBody.indexOf("await loadReferencedSqlFiles(");
    const firstRecheckIdx = sendBody.indexOf("if (!generationCanContinue()) return;", sqlFilesIdx);
    const contextIdx = sendBody.indexOf("const context = await buildAiContext(");
    const secondRecheckIdx = sendBody.indexOf("if (!generationCanContinue()) return;", contextIdx);
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
    const pushIdx = sendBody.indexOf('runMessages.push({ role: "assistant"');
    const assistantIdxIdx = sendBody.indexOf("const assistantIdx = runMessages.length - 1;", pushIdx);
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
    // Issue #6743 feature 1: the live generation-status line is per-request
    // transient state too — the 1s status timer and the status ref must be reset
    // here, otherwise switching conversations leaks a stale status line (and a
    // running interval) into the next generation.
    expect(resetBody).toContain("stopStatusTimer();");
    expect(resetBody).toContain("generationStatus.value = createGenerationStatus(Date.now());");

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
    expect(body).toContain("if (isGenerating.value && !backgroundAiRunsEnabled) abandonInFlightRequest();");
    expect(body).not.toContain("cancelStream();");
  });

  it("queues simultaneous background auto-sends instead of overwriting a single pending target", () => {
    // Several detached runs can settle in the same turn. A single mutable
    // `pendingAutoSend` slot lost whichever queued input was scheduled first.
    expect(source).toContain("const pendingAutoSends: PendingAutoSend[] = [];");
    const sendBody = bodyOf("async function send()");
    expect(sendBody).toContain("const auto = pendingAutoSends.shift() ?? null;");
    const scheduleBody = bodyOf("function scheduleAutoSend(");
    expect(scheduleBody).toContain("pendingAutoSends.push(");
  });

  it("makes successfully persisted background conversations navigable without reopening the list", () => {
    const snapshotBody = bodyOf("async function persistDesktopRunSnapshot(");
    expect(snapshotBody).toContain(".then(() => syncPersistedConversation(conversation))");
    const syncBody = bodyOf("function syncPersistedConversation(conversation: AiConversation)");
    expect(syncBody).toContain("conversations.value.unshift(conversation);");
    expect(syncBody).toContain("conversations.value.sort(");
  });

  it("does not replace an in-memory desktop run when the AI panel remounts", () => {
    const mountedBody = bodyOf("onMounted(async () => {");
    expect(mountedBody).toContain("const liveRun = desktopAiRun<ChatMessage>(persistedRun.conversationId);");
    expect(mountedBody).toContain("if (liveRun) {");
    expect(mountedBody).toContain("continue;");
  });

  it("agent step cards render a running-tool tail and a computed duration tail", () => {
    // Issue #6743 (feature-1 gap): per-tool execution time in the agent step cards —
    // mockup shows a spinner + "执行中…" tail on running steps and `0.8s`/`1.2s` on
    // completed steps. The step-row template must special-case running tool steps
    // (spinner icon + executing tail) and completed tool steps (tabular duration).
    const stepsStart = source.indexOf('v-for="step in msg.agentSteps"');
    expect(stepsStart, "expected to find the agent-steps v-for in AiAssistant.vue").toBeGreaterThanOrEqual(0);
    const stepsBlock = source.slice(stepsStart);
    // Running tool step: spinner leading icon + right-aligned "executing…" tail.
    expect(stepsBlock).toContain("step.tone === 'active' && step.toolName");
    expect(stepsBlock).toContain('t("ai.agentSteps.executing")');
    // Completed tool step: right-aligned tabular duration tail.
    expect(stepsBlock).toContain("formatToolDurationMs(step.durationMs)");
  });

  it("the status-line idle branch swaps Clock for Hourglass (mockup alignment)", () => {
    // Mockup: idle state shows a non-spinning hourglass (spinner animation stops);
    // only the >60s hint below keeps the Clock. The swap must live in the status
    // line's spinner/clock slot, not touch the hint.
    const statusLineIdx = source.indexOf("data-ai-generation-status");
    expect(statusLineIdx).toBeGreaterThanOrEqual(0);
    const statusBlock = source.slice(statusLineIdx);
    expect(statusBlock).toContain("<Hourglass v-else");
  });

  // --- Review findings on background AI session tasks (see the two findings
  // evaluated in this session) ---

  it("persists detached streaming snapshots incrementally from the delta flush path", () => {
    // Finding 1: detached deltas were flushed only into memory (plus a scroll
    // callback), so a crash/quit mid-response lost everything after the
    // pre-stream snapshot. The flush path must now schedule throttled,
    // serialized snapshot persistence.
    const sendBody = bodyOf("async function send()");
    const bufferIdx = sendBody.indexOf("createDetachedAssistantDeltaBuffer(runMessages, () => {");
    expect(bufferIdx).toBeGreaterThanOrEqual(0);
    const flushBlock = sendBody.slice(bufferIdx, sendBody.indexOf(": undefined", bufferIdx));
    expect(flushBlock).toContain("runSnapshotScheduler.schedule(detachedRun);");
    // The pre-stream snapshot and the finally go through the same serialized
    // scheduler so a slow write can never reorder around them.
    expect(sendBody).toContain("void runSnapshotScheduler.save(detachedRun)");
    // The scheduler itself lives at module scope (the flush callback and the
    // stop path both use it), configured with the streaming interval.
    expect(source).toContain("const runSnapshotScheduler = createDesktopAiRunSnapshotScheduler<ChatMessage>({");
    expect(source).toContain("intervalMs: RUN_SNAPSHOT_PERSIST_INTERVAL_MS");
  });

  it("send() resolves the run's settled signal on every exit path so a stop can wait for the real terminal event", () => {
    // Finding 2: the stop path must not finalize the run itself; it waits for
    // the pipeline's terminal event via the run's `settled` promise. Every
    // exit path of send() must resolve it (finally + three pre-stream early
    // returns), or a stop fired there would sit out the full timeout.
    const sendBody = bodyOf("async function send()");
    expect(sendBody).toContain("detachedRun.settled = new Promise<void>((resolve) => {");
    const finallyIdx = sendBody.indexOf("} finally {");
    const finallyBody = sendBody.slice(finallyIdx);
    expect(finallyBody).toContain("resolveDetachedRunSettled();");
    const settledCalls = sendBody.match(/resolveDetachedRunSettled\(\);/g) ?? [];
    expect(settledCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("the finally skips finalization for a run that no longer owns its registry slot", () => {
    // Finding 2: after a stop-side force-abandon (or a delete/replacement send)
    // retires the run, the old pipeline's finally must not re-run the finish
    // chain - updateDesktopAiRun() re-inserts unconditionally, which would
    // resurrect the retired run over whatever now owns the conversation.
    const sendBody = bodyOf("async function send()");
    const finallyIdx = sendBody.indexOf("} finally {");
    const finallyBody = sendBody.slice(finallyIdx);
    expect(finallyBody).toContain("const runStillOwned = detachedRun ? desktopAiRun(detachedRun.conversationId) === detachedRun : false;");
    expect(finallyBody).toContain("if (detachedRun && runStillOwned) {");
    expect(finallyBody).toContain("runSnapshotScheduler.cancel(detachedRun.runId);");
    expect(finallyBody).toContain("void runSnapshotScheduler.save(detachedRun).finally(");
    expect(finallyBody).toContain("} else if (!detachedRun) {");
  });

  it("stopDesktopAiRun keeps a background run active until the pipeline settles, force-abandoning after the timeout", () => {
    // Finding 2: the old stop path finished+retired immediately, so a hung or
    // cancellation-pending stream went invisible while still occupying its slot.
    // The shared helper must reflect the request but defer finalization to the
    // pipeline's finally or the bounded force-abandon.
    const body = bodyOf("async function stopDesktopAiRun(");
    expect(body).toContain("run.cancelRequested = true;");
    expect(body).toContain("waitForDesktopRunSettled(run)");
    expect(body).toContain("requestDesktopRunCancellation(run, deadlineAt)");
    expect(body).toContain("await forceAbandonDesktopAiRun(run);");
    // Only the never-admitted queued branch finalizes immediately.
    expect(body).toContain('if (run.status === "queued")');
    expect(body).toContain("cancelQueuedDesktopAiRun(run);");
  });

  it("the stop path consumes the aiCancelStream acknowledgement and retries while unacknowledged", () => {
    // Finding 2: aiCancelStream() returns a boolean (true only when the session
    // id is registered with the backend) that was discarded. The retry loop
    // lands the cancellation once the session registers during context
    // preparation.
    const body = bodyOf("async function requestDesktopRunCancellation(");
    expect(body).toContain("const acknowledged = await aiCancelStream(run.currentSessionId).catch(() => false);");
    expect(body).toContain("if (acknowledged) return;");
    expect(body).toContain("DESKTOP_CANCEL_ACK_RETRY_MS");
  });

  it("stopDesktopAiRun fire-and-forgets the cancel retry so a hung IPC cannot block the bounded force-abandon", () => {
    // Reviewed finding (deadlock, HIGH): stopDesktopAiRun() awaited
    // requestDesktopRunCancellation(), which awaits aiCancelStream() directly.
    // If the IPC never returned, the STOP_FORCE_ABANDON_MS race was never read
    // and the stop never force-abandoned — a hung cancel RPC stranded the run
    // exactly like the hung stream it was meant to recover from.
    const body = bodyOf("async function stopDesktopAiRun(");
    expect(body).toContain("void requestDesktopRunCancellation(run, deadlineAt);");
    expect(body).not.toContain("await requestDesktopRunCancellation(run, deadlineAt);");
    // The bounded settle race drives the force-abandon, not the cancel RPC.
    expect(body).toContain("if (await settled) {");
  });

  it("both stop entry points delegate to the shared stopDesktopAiRun helper", () => {
    const cancelBody = bodyOf("async function cancelStream()");
    expect(cancelBody).toContain("await stopDesktopAiRun(run);");
    expect(cancelBody).not.toContain('finishDesktopAiRun(run, "cancelled")');
    const rowBody = bodyOf("async function stopConversationRun(");
    expect(rowBody).toContain("await stopDesktopAiRun(run);");
  });

  it("keeps long task summaries out of the fixed-width history popover", () => {
    // The history popover is always w-72, but min-[430px] responds to viewport
    // width. On desktop it displayed long summaries inside the compact row,
    // squeezing the conversation title and forcing horizontal scrolling. The
    // status icon still exposes the full text through its title/ARIA metadata.
    const historyStart = source.indexOf('<PopoverContent align="end" class="w-72 gap-0 p-0"');
    const history = source.slice(historyStart);
    expect(history).toContain(":title=\"conversationRowDetail(conv).summary ?? t('ai.runStatusCompleted')\"");
    expect(history).toContain(":title=\"conversationRowDetail(conv).reason ?? t(conversationRowDetail(conv).status === 'interrupted' ? 'ai.runStatusInterrupted' : 'ai.runStatusFailed')\"");
    expect(history).not.toContain("conversationRowDetail(conv).summary }}</span>");
    expect(history).not.toContain("conversationRowDetail(conv).reason }}</span>");
  });
});
