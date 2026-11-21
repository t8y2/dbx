import { describe, expect, it } from "vitest";
import { aiSqlActionFeedback, type AiSqlActionOutcome } from "../aiSqlActionFeedback";

// Regression coverage for https://github.com/t8y2/dbx/issues/11962.
//
// An AI SQL action is delivered to an editor tab resolved from the
// conversation's bound connection, and that tab is deliberately created without
// activation (#9902). When it is not the active tab of any editor group, the
// click used to change nothing on screen and the database error landed only in
// that background tab. This decision table is what the panel says instead.
describe("aiSqlActionFeedback (#11962)", () => {
  const started = (ok: boolean, errorMessage?: string): AiSqlActionOutcome => ({ status: "started", ok, tabId: "tab-1", ...(errorMessage ? { errorMessage } : {}) });

  it("announces a success with the target tab's title and a reveal action when the tab is off screen", () => {
    // The `*In` key, not the block's `sqlActionSucceeded`: the user is looking at
    // the panel, so the toast has to name the tab the result landed in.
    expect(aiSqlActionFeedback(started(true), { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({
      level: "info",
      messageKey: "ai.sqlActionSucceededIn",
      params: { title: "MySQL@app" },
      revealTabId: "tab-1",
    });
  });

  it("reports the database error text when the tab is off screen", () => {
    const feedback = aiSqlActionFeedback(started(false, "Unknown column 'u.foo' in 'field list'"), { targetOnScreen: false, tabTitle: "MySQL@app" });

    expect(feedback.level).toBe("error");
    expect(feedback).toMatchObject({ messageKey: "ai.sqlActionFailed", params: { title: "MySQL@app", message: "Unknown column 'u.foo' in 'field list'" }, revealTabId: "tab-1" });
  });

  it("stays silent whenever the target tab is on screen", () => {
    // This is the #9902 regression guard: the tab itself shows the result and the
    // error, and an AI action must never add a toast on top of it.
    for (const outcome of [started(true), started(false, "boom"), { status: "applied" as const, tabId: "tab-1" }]) {
      expect(aiSqlActionFeedback(outcome, { targetOnScreen: true, tabTitle: "MySQL@app" })).toEqual({ level: "none" });
    }
  });

  it("falls back to the tab id when the tab has no display title", () => {
    expect(aiSqlActionFeedback(started(true), { targetOnScreen: false })).toMatchObject({ params: { title: "tab-1" } });
  });

  it("reports apply without an execution summary", () => {
    expect(aiSqlActionFeedback({ status: "applied", tabId: "tab-1" }, { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({
      level: "info",
      messageKey: "ai.sqlActionAppliedIn",
      params: { title: "MySQL@app" },
      revealTabId: "tab-1",
    });
  });

  it("never activates anything itself: the reveal id is data, not an action", () => {
    // The mapper has no activation entry point at all — App.vue wires
    // `revealTabId` to the toast's [查看] button, and only that click switches.
    const feedback = aiSqlActionFeedback(started(true), { targetOnScreen: false, tabTitle: "t" });
    expect(Object.keys(feedback).sort()).toEqual(["level", "messageKey", "params", "revealTabId"]);
  });

  it("does not add a second notice when the user already saw a dialog or toast", () => {
    // Danger / production / parameter / read-only dialogs, the blocked-Redis
    // toast and the "select a database" toast are all produced elsewhere.
    for (const reason of ["cancelled", "parameters", "blocked", "missing-database"] as const) {
      expect(aiSqlActionFeedback({ status: "not-started", reason, tabId: "tab-1" }, { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({ level: "none" });
    }
  });

  it("makes the silent early returns visible", () => {
    expect(aiSqlActionFeedback({ status: "not-started", reason: "no-connection" }, { targetOnScreen: false })).toEqual({ level: "error", messageKey: "ai.sqlActionNoConnection", params: {} });
    expect(aiSqlActionFeedback({ status: "not-started", reason: "empty-sql", tabId: "tab-1" }, { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({
      level: "error",
      messageKey: "ai.sqlActionEmptySql",
      params: {},
      revealTabId: "tab-1",
    });
    expect(aiSqlActionFeedback({ status: "not-started", reason: "busy", tabId: "tab-1" }, { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({
      level: "error",
      messageKey: "ai.sqlActionBusy",
      params: {},
      revealTabId: "tab-1",
    });
  });

  it("treats an unresolvable tab as a no-tab report even when a stale id is carried", () => {
    expect(aiSqlActionFeedback({ status: "not-started", reason: "no-tab", tabId: "tab-gone" }, { targetOnScreen: false })).toMatchObject({ level: "error", messageKey: "ai.sqlActionNoConnection" });
  });

  it("stays silent while a dialog parks the execution", () => {
    // The dialog itself is the visible surface; the caller keeps waiting and the
    // resumed execution reports through App's deferred path.
    for (const reason of ["parameters", "danger", "redis-confirm"] as const) {
      expect(aiSqlActionFeedback({ status: "deferred", reason, tabId: "tab-1" }, { targetOnScreen: false, tabTitle: "MySQL@app" })).toEqual({ level: "none" });
    }
  });

  it("omits the reveal id for a target that no longer exists", () => {
    const feedback = aiSqlActionFeedback({ status: "not-started", reason: "empty-sql" }, { targetOnScreen: false });
    expect(feedback).toEqual({ level: "error", messageKey: "ai.sqlActionEmptySql", params: {} });
    expect("revealTabId" in feedback).toBe(false);
  });
});
