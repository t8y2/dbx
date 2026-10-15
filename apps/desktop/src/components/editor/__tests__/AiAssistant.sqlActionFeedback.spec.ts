import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/11962.
//
// The AI panel's SQL actions deliver to an editor tab resolved from the
// conversation's bound connection, created without activation (#9902). When the
// tab was not on screen the click looked like a no-op and the database error
// stayed in that background tab. App.vue is a large SFC the suite never mounts,
// so the wiring is pinned as source text (same approach as
// aiRedisConsoleRouting.spec.ts); the decision table itself is unit-tested in
// lib/ai/__tests__/aiSqlActionFeedback.spec.ts.
//
// These assertions read the .vue sources verbatim, so run `oxfmt` on the changed
// files BEFORE running this spec — a reflow of the pinned text fails it.
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

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

describe("AI SQL action feedback (#11962)", () => {
  it("treats a target tab as visible only when the workspace renders and some group shows it", () => {
    const onScreen = appBodyOf("function aiTargetTabOnScreen(tabId: string): boolean");
    expect(onScreen).toContain("workspaceRendered()");
    // Same idiom as SqlEditorWorkspace.editorGroupForTab: every group renders, so
    // a non-focused split group's active tab counts as visible.
    expect(onScreen).toContain("queryStore.groups.some((group) => group.activeTabId === tabId)");

    const rendered = appBodyOf("function workspaceRendered(): boolean");
    // Mirrors the v-show on [data-editor-content]: a maximized AI panel hides the
    // workspace, so nothing in it can deliver feedback.
    expect(rendered).toContain("!isAiPanelMaximized.value");
    expect(rendered).toContain("!isHistoryPanelMaximized.value");
    expect(rendered).toContain("!isSpecialPageActive.value");
    expect(rendered).not.toContain("isZenMode");
  });

  it("routes the feedback decision through the pure mapper and only reveals on click", () => {
    const settle = appBodyOf("function settleAiSqlAction(requestId: number | undefined, outcome: AiSqlActionOutcome): void");

    expect(settle).toContain("aiSqlActionFeedback(outcome, { targetOnScreen");
    expect(settle).toContain('if (feedback.level === "none" || feedbackText === undefined) return;');
    // The toast's action button is the ONLY activation site on this path.
    expect(settle).toContain("onClick: () => activateQueryTab(revealTabId)");
    expect(settle).not.toContain("activateQueryTab(tabId)");
    expect(settle).toContain("aiAssistantRef.value.reportAiSqlAction(report);");
    // The summary shown in the panel comes from the target tab's own result.
    expect(settle).toContain("aiTargetResultCounts(outcome.tabId)");
    // A request that never started still says why inside the block, where the text
    // outlives the toast.
    expect(settle).toContain('{ requestId, status: "unavailable" as const, ...(feedbackText ? { message: feedbackText } : {}) }');
  });

  it("reports dismissal instead of re-toasting a dialog the user already answered", () => {
    const reasons = appSource.slice(appSource.indexOf("const DISMISSED_OUTCOME_REASONS"), appSource.indexOf("const DISMISSED_OUTCOME_REASONS") + 200);
    for (const reason of ["cancelled", "parameters", "blocked", "missing-database"]) expect(reasons).toContain(`"${reason}"`);
  });

  it("leaves no silent early return on the three AI SQL action paths", () => {
    for (const handler of ["function onAiAppendSql(", "function onAiExecuteSql("]) {
      const body = appBodyOf(handler);
      // Every `!tabId` branch settles with a reportable reason...
      expect(body).toContain('settleAiSqlAction(requestId, { status: "not-started", reason: "no-connection" });');
      expect(body).not.toMatch(/if \(!tabId\) return;/);
    }
    // ...including the temp-run path, which has no branch of its own and hands
    // the empty tab id to the shared helper.
    expect(appBodyOf("function runAiGeneratedSql(")).toContain("if (!tabId) {");
    expect(appBodyOf("function runAiGeneratedSql(")).toContain('settleAiSqlAction(requestId, { status: "not-started", reason: "no-connection" });');
    expect(appBodyOf("function runAiGeneratedSql(")).toContain("await tryExecute(sql, { tabId })");
    expect(appBodyOf("function onAiTempRunSql(")).toContain("void runAiGeneratedSql(sql, ensureQueryTabForConnection(target), requestId);");
  });

  it("keeps #9902 intact: the AI action itself never moves the workspace", () => {
    // Target resolution is unchanged (connection + database + exact schema).
    const target = appBodyOf("function ensureQueryTabForConnection(target: AiConversationBinding): string");
    expect(target).toContain("{ activate: false }");
    // No AI action handler activates, selects or creates a tab behind the user's back.
    for (const handler of ["function onAiAppendSql(", "function onAiExecuteSql(", "function onAiTempRunSql(", "function runAiGeneratedSql("]) {
      const body = appBodyOf(handler);
      expect(body).not.toContain("activateTab");
      expect(body).not.toContain("switchTab");
    }
  });

  it("passes the request id through every AI action emit", () => {
    expect(appSource).toContain('@append-sql="onAiAppendSql"');
    expect(appSource).toContain('@execute-sql="onAiExecuteSql"');
    expect(appSource).toContain('@temp-run-sql="onAiTempRunSql"');
    // Every AI action emit forwards the request id as a third argument.
    const assistant = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
    expect(assistant).toContain('emit("appendSql", code, conversationBinding.value, requestId);');
    expect(assistant).toContain('emit("executeSql", code, conversationBinding.value, requestId);');
    expect(assistant).toContain('emit("tempRunSql", code, conversationBinding.value, requestId);');
    // The auto-execute path is deliberately excluded: it already reports in-chat.
    expect(appSource).toContain('@request-auto-execute-sql="onAiRequestAutoExecuteSql"');
    expect(appBodyOf("function onAiRequestAutoExecuteSql(")).not.toContain("settleAiSqlAction");
  });

  it("declares the panel report method on the handle type and the component", () => {
    expect(appSource).toContain("reportAiSqlAction: (report: AiSqlActionReport) => void;");
    const assistant = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
    expect(assistant).toContain("function reportAiSqlAction(report: AiSqlActionReport)");
    expect(assistant).toContain("defineExpose({ openPluginConversation, openExternalContext, triggerAction, clearContextReferences, selectConversationById, focusSearch, reportAiSqlAction });");
  });

  it("drops positional block statuses whenever the transcript is replaced", () => {
    const assistant = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
    // Block keys are positional (`code:<message>:<segment>`), so a status left
    // behind by a wiped transcript would render as the outcome of whatever block
    // now sits at that index — another conversation's error, or the regenerated
    // message of an edit-resend.
    expect(assistant.match(/function clearSqlActionBlockStatuses\(/g)).toHaveLength(1);
    for (const replaced of [
      "messages.value = messages.value.slice(0, actualIndex);", // edit-resend truncation
      "messages.value = [];", // clearMessages (new chat)
      "messages.value = activeRun?.messages ?? chatMessagesFromConversation(conv);", // selectConversation
    ]) {
      const at = assistant.indexOf(replaced);
      expect(at, `expected to find "${replaced}" in AiAssistant.vue`).toBeGreaterThanOrEqual(0);
      expect(assistant.slice(at, at + 300)).toContain("clearSqlActionBlockStatuses();");
    }
  });

  it("announces the block outcome through a status live region", () => {
    const assistant = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
    // The outcome lands in the transcript, not in the tab the user is looking at,
    // so it has to be announced. `role="status"` matches the other block-level
    // notices in this file; the row stays mounted between running and terminal, so
    // the change is a text mutation inside an existing live region.
    const row = assistant.slice(assistant.indexOf("data-ai-sql-action-status"));
    expect(row.slice(0, 200)).toContain('role="status"');
  });

  it("lets the newest click on a block own its status", () => {
    const assistant = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
    // Clicking the same block twice used to let the FIRST response settle the
    // block (last write wins by arrival order, not by click order).
    expect(assistant).toContain('next.set(key, { phase: "running", requestId });');
    expect(assistant).toContain('if (pending?.phase === "running" && pending.requestId !== report.requestId)');
  });

  it("carries the AI request across a dialog-parked execution", () => {
    // A parameter / danger / Redis dialog makes tryExecute return `deferred`, so the
    // settled execution has to be correlated back to the click: App remembers the
    // request per tab and settles from the resumed execution.
    const settle = appBodyOf("function settleAiSqlAction(requestId: number | undefined, outcome: AiSqlActionOutcome): void");
    expect(settle).toContain('if (outcome.status === "deferred") {');
    expect(settle).toContain("rememberDeferredAiSqlAction(outcome.tabId, requestId);");

    const deferredSettle = appBodyOf("function settleDeferredAiSqlAction(outcome: SqlExecutionOutcome): void");
    expect(deferredSettle).toContain("deferredAiSqlActions.get(tabId)");
    expect(deferredSettle).toContain("if (requestId === undefined) return;");
    expect(deferredSettle).toContain("settleAiSqlAction(requestId, outcome);");
    // Editor-initiated executions reach the same callback and must not be toasted.
    expect(deferredSettle).toContain("deferredAiSqlActions.delete(tabId);");

    // The composable reports exactly where the dialog's own handlers discarded the
    // outcome before (#11962 review).
    const execution = readFileSync(new URL("../../../composables/useSqlExecution.ts", import.meta.url), "utf8");
    expect(execution).toContain("reportDeferredExecution(await doExecute(sql, sourceOffset, { openInNewResultTab, editorViewportRequestId, tabId: tab.id }));");
    expect(execution).toContain("reportDeferredExecution(await continueExecute(context, sql, sourceOffset,");
    expect(execution).toContain('return deferred("parameters", context.tabId);');
    expect(execution).toContain('return deferred("danger", context.tabId);');
    expect(execution).toContain('return deferred("redis-confirm", context.tabId);');
    // Cancelling a dialog unbinds the parked request instead of leaving it waiting.
    expect(execution).toContain('if (abandonedTabId) reportDeferredExecution(notStarted("cancelled", abandonedTabId));');
  });

  it("names the target tab in the off-screen toast of every locale", () => {
    // The toast is the only thing that tells the user *where* an off-screen run
    // landed, so these keys must interpolate the tab title — and the block copy
    // must not (it renders under the SQL, with no tab name to interpolate).
    const locales = ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "ru", "th", "tr", "zh-CN", "zh-TW"];
    for (const locale of locales) {
      const messages = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(messages, locale).toMatch(/sqlActionSucceededIn: "[^"]*\{title\}[^"]*"/);
      expect(messages, locale).toMatch(/sqlActionAppliedIn: "[^"]*\{title\}[^"]*"/);
      expect(messages, locale).toMatch(/sqlActionFailed: "[^"]*\{title\}[^"]*\{message\}[^"]*"/);
      expect(messages, locale).toMatch(/sqlActionSucceeded: "[^"{]*"/);
    }
  });
});
