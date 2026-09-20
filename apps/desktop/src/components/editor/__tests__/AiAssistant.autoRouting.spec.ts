import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #9118: the AI assistant exposes one "Auto" entry at the head of both action
// menus. These assertions pin the parts of the wiring that a behavioral unit
// test cannot reach (the component owns a large amount of shared state):
//
// - every explicit action stays in the menu, "auto" is only prepended;
// - the selection starts concrete; Auto is preselected on new conversations
//   only through the Settings > AI "default auto routing" toggle;
// - "auto" is resolved to a concrete action BEFORE the request is assembled, so
//   `taskContract.action` never carries it (the backend interpolates that value
//   into its system prompt and uses it for final-answer contract validation);
// - the vector-DB branch (hidden picker, forced `generate`) is untouched;
// - external explicit triggers (`triggerAction`) bypass the router.
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

describe("Auto picker entry", () => {
  it("heads both action lists without removing any explicit action", () => {
    const askList = source.slice(source.indexOf("const askActionButtons: AiActionButton[] = ["), source.indexOf("const agentActionButtons: AiActionButton[] = ["));
    const agentList = source.slice(source.indexOf("const agentActionButtons: AiActionButton[] = ["), source.indexOf("const actionButtons = computed"));

    for (const [label, list] of [
      ["ask", askList],
      ["agent", agentList],
    ] as const) {
      const autoIdx = list.indexOf("autoActionButton,");
      expect(autoIdx, `${label}: auto entry`).toBeGreaterThanOrEqual(0);
      expect(autoIdx, `${label}: auto must be first`).toBeLessThan(list.indexOf('action: "general"'));
      // The pre-existing actions are all still present.
      expect(list, `${label}: general`).toContain('action: "general"');
      expect(list, `${label}: generate`).toContain('action: "generate"');
    }
    expect(askList).toContain('action: "sampleData"');
    expect(askList).toContain('action: "convert"');
    expect(agentList).toContain('action: "executeAndExplain"');
    expect(agentList).toContain('action: "exploreSchema"');
    expect(agentList).toContain('action: "query"');
  });

  it("widens the picker type instead of the transport action union", () => {
    // The menu entry uses the UI-only `AiActionSelection`; `AiAction` (what the
    // request carries) stays a concrete action.
    const buttonInterface = bodyOf("interface AiActionButton {");
    expect(buttonInterface).toContain("action: AiActionSelection;");
    expect(buttonInterface).not.toContain("action: AiAction;");
    expect(source).toContain('import { classifyIntentByLlm, routeIntentByRules, type AiIntentRouteInput } from "@/lib/ai/aiIntentRouter";');
    expect(source).toContain("type AiActionSelection,");
  });

  it("keeps resolveDefaultAction concrete; auto preselection flows only through the settings toggle", () => {
    expect(source).toContain('const activeAction = ref<AiActionSelection>("general");');
    const resolveDefault = bodyOf("function resolveDefaultAction(mode: AiAssistantMode): AiAction");
    expect(resolveDefault).not.toContain("auto");
    expect(resolveDefault).toContain("defaultActionForMode(mode)");

    const resolveSelection = bodyOf("function resolveDefaultActionSelection(mode: AiAssistantMode): AiActionSelection");
    // Auto only when the Settings > AI toggle is on, and never for vector DBs:
    // their picker is hidden and the task contract must not invite querying.
    expect(resolveSelection).toContain("settings.defaultAutoRouting");
    expect(resolveSelection.indexOf('return "auto";')).toBeGreaterThanOrEqual(0);
    expect(resolveSelection.indexOf('return "auto";')).toBeLessThan(resolveSelection.indexOf("resolveDefaultAction(mode)"));
    expect(resolveSelection).toContain("isVectorDbType(props.connection.db_type)");
  });

  it("lands new conversations, mode switches and mount init on the settings-driven default", () => {
    expect(bodyOf("function startNewChat()")).toContain("resolveDefaultActionSelection(mode);");
    expect(bodyOf("watch(assistantMode, (mode) => {")).toContain("resolveDefaultActionSelection(mode);");
    expect(bodyOf('function switchModeActionTab(mode: "ask" | "agent") {')).toContain("resolveDefaultActionSelection(mode);");
    // Mount init applies the default exactly once (apply-once rule shared with
    // the default mode). The picker is panel-scoped: no restore path
    // (`selectConversation`) writes it, so the settings-driven default survives
    // restoring the last conversation.
    expect(source).toContain("activeAction.value = resolveDefaultActionSelection(settings.defaultAiMode);");
  });

  it("hides the action list for vector databases and still forces generate there", () => {
    const listStart = source.indexOf("<!-- Action list -->");
    const pickerList = source.slice(listStart, source.indexOf("</PopoverContent>", listStart));
    expect(pickerList).toContain('v-for="button in actionButtons"');
    // The list (Auto included) only renders when the action picker is shown.
    const templateGuardIdx = source.lastIndexOf('<template v-if="showActionButtons">', listStart);
    expect(templateGuardIdx).toBeGreaterThanOrEqual(0);

    const vectorWatchStart = source.indexOf("() => props.connection?.db_type,");
    const vectorWatch = source.slice(vectorWatchStart, source.indexOf("{ immediate: true },", vectorWatchStart));
    expect(vectorWatch).toContain('activeAction.value = "generate";');
  });
});

describe("Auto routing at send time", () => {
  it("resolves the selection before the request reaches the backend", () => {
    const sendBody = bodyOf("async function send()");
    const routingIdx = sendBody.indexOf("await resolveAutoAction(");
    const streamIdx = sendBody.indexOf("await runAgentStream(");
    const contractIdx = sendBody.indexOf("action: requestedAction,");
    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThan(routingIdx);
    expect(contractIdx).toBeGreaterThan(routingIdx);
    // Auto is only routed when it was actually selected; every explicit
    // selection is passed through untouched.
    expect(sendBody).toContain("requestedAction = requestedSelection;");
    expect(sendBody).toContain("requestedAction = await resolveAutoAction(text, requestedMode, runIsVisible());");
    // A confirmed-write turn replies with component copy, so the router must not
    // run on it: the mode default keeps the pre-Auto confirmation contract.
    expect(sendBody).toContain("const confirmationContinuation = allowWriteSqlForNextRun || resumingConfirmedWrite;");
    expect(sendBody).toContain("requestedAction = resolveDefaultAction(requestedMode);");
    // A stop/clear/switch that lands during the classifier wait must not start
    // a request nobody can reach.
    expect(sendBody.indexOf("if (!generationCanContinue()) {", routingIdx)).toBeGreaterThan(routingIdx);
  });

  it("records the routing outcome on the user message and shows the recognizing indicator", () => {
    const sendBody = bodyOf("async function send()");
    expect(sendBody).toContain('userMessage.routedFrom = "auto";');
    expect(sendBody).toContain("userMessage.routedAction = requestedAction;");

    const resolveBody = bodyOf("async function resolveAutoAction(text: string, mode: AiAssistantMode, showProgress: boolean): Promise<AiAction>");
    // Zero-latency rule layer first; the classifier (network) only on a miss.
    expect(resolveBody.indexOf("routeIntentByRules(input)")).toBeLessThan(resolveBody.indexOf("classifyIntentByLlm(input,"));
    expect(resolveBody).toContain("if (showProgress) routingInFlight.value = true;");
    expect(resolveBody).toContain("if (showProgress) routingInFlight.value = false;");
    expect(source).toContain("data-ai-auto-routing");
    expect(source).toContain('t("ai.routing.recognizing")');
  });

  it("renders the Auto chip on the routed message and switches back to the explicit action", () => {
    expect(source).toContain("data-ai-auto-routed-chip");
    expect(source).toContain('t("ai.routing.chip", { action: actionLabelFor(routedActionOf(msg)) })');

    const switchBody = bodyOf("function switchToRoutedAction(action: AiAction | null | undefined)");
    // Reuses the mode-switch suppression handshake so the watch cannot reset the
    // action right after the chip set it.
    expect(switchBody.indexOf("suppressModeActionReset = true;")).toBeLessThan(switchBody.indexOf('assistantMode.value = isValidActionForMode(action, "ask") ? "ask" : "agent";'));
    expect(switchBody.indexOf('assistantMode.value = isValidActionForMode(action, "ask") ? "ask" : "agent";')).toBeLessThan(switchBody.indexOf("activeAction.value = action;"));
  });

  it("clears the recognizing indicator on the abandon path, not just the classifier's finally", () => {
    // Dual-path rule for per-request transient state (see
    // AiAssistant.clearAndCancel.spec.ts): the classifier's `finally` covers the
    // normal path, so clearMessages()/selectConversation()/onUnmounted must drop
    // the flag synchronously via resetPendingRequestState().
    expect(bodyOf("function resetPendingRequestState()")).toContain("routingInFlight.value = false;");
    expect(bodyOf("async function resolveAutoAction(text: string, mode: AiAssistantMode, showProgress: boolean): Promise<AiAction>")).toContain("if (showProgress) routingInFlight.value = false;");
  });

  it("keeps external explicit triggers on the direct path", () => {
    const triggerBody = bodyOf("function triggerAction(action: AiAction, instruction?: string)");
    expect(triggerBody).toContain("activeAction.value = action;");
    expect(triggerBody).not.toContain("resolveAutoAction");
    expect(triggerBody).not.toContain("routeIntentByRules");
  });
});
