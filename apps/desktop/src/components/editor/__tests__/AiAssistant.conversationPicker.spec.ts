import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/12075:
//
// The Ask/Agent mode + action picker used to be two panel-level refs with no
// per-conversation owner and no persistence, so switching conversations carried
// one chat's choice into another, closing the AI panel reset it to the settings
// default ("Ask · 通用问答"), and no conversation ever reopened with its own
// choice.
//
// AiAssistant.vue is a ~6000-line SFC the suite never mounts, so the wiring that
// gives each conversation its own selection is pinned as text, matching the
// #9902 pattern in `AiAssistant.conversationBinding.spec.ts`. The rules
// themselves are unit-tested in `lib/ai/__tests__/aiConversationPicker.spec.ts`,
// and the restore/record order in
// `lib/ai/__tests__/aiConversationPickerState.spec.ts`.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
const rules = readFileSync(new URL("../../../lib/ai/aiConversationPicker.ts", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../../../lib/ai/aiConversationPickerState.ts", import.meta.url), "utf8");

/**
 * The `{ … }` block that opens on `signature`'s own line. Every pinned signature
 * below keeps its opening brace as the last one on that line — which is also how
 * a return type such as `): { mode: string } {` stays unambiguous.
 */
function bodyAt(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `expected to find "${signature}" in AiAssistant.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = source.lastIndexOf("{", source.indexOf("\n", start));
  expect(source.slice(braceStart, braceStart + 1), `expected "${signature}" to open a block on its line`).toBe("{");
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${signature}"`);
}

describe("AI conversation owns its mode + action selection (#12075)", () => {
  it("keeps the picker selection per conversation, keyed like the skill state", () => {
    expect(source).toContain("const conversationPickerSelections = createReactiveMap(new Map<string, AiPickerSelection>());");
    // The unsaved chat is a single slot, so two drafts can never trade values (R4).
    expect(bodyAt("function pickerSelectionKey()")).toContain("conversationId.value || unsavedConversationKey.value");
  });

  it("restores the arriving conversation's own selection instead of leaving the previous one", () => {
    const body = bodyAt("function selectConversation(conv: AiConversation)");
    expect(body).toContain("restoreConversationPicker(conv)");
    // The plugin-only branch that always forced `general` was replaced: the
    // plugin rules are one of the cases `resolveConversationPicker` replays.
    expect(body).not.toContain('activeAction.value = "general"');
    expect(bodyAt("function restoreConversationPicker(conv: AiConversation)")).toContain("resolveConversationPicker(pickerRecordFor(conv), pickerAmbient())");
  });

  it("leaves the new-chat starting point exactly as it was (R3)", () => {
    const body = bodyAt("function startNewChat()");
    expect(body).toContain("picker.restoreDefault()");
    // The settings semantics must survive: `restoreDefault` lands on the
    // settings default mode and, with the Settings > AI toggle on, on `auto`.
    expect(body).not.toContain("assistantMode.value =");
    expect(body).not.toContain("activeAction.value =");
    expect(controllerSource).toContain("const next = { mode: ambient().defaultMode, action: resolveDefaultPickerSelection(ambient().defaultMode, ambient()) };");
    expect(rules).toContain('return ambient.defaultAutoRouting ? "auto" : defaultActionForMode(mode);');
  });

  it("runs another conversation's retry and queued input on that conversation's own values (R7)", () => {
    const retry = bodyAt("function retryConversationRun(");
    expect(retry).toContain("const retrySelection = conversationPickerSelectionFor(convId);");
    expect(retry).toContain("mode: retrySelection.mode, action: retrySelection.action");
    // Never the visible chat's picker refs.
    expect(retry).not.toContain("mode: assistantMode.value");

    // The startup restore of persisted "send later" inputs does the same.
    expect(source).toContain("const queuedSelection = conversationPickerSelectionFor(conversation.id);");
    expect(source).not.toContain("queuedInputs.set(conversation.id, { text: conversation.queuedInput, mode: assistantMode.value, action: activeAction.value });");
  });

  it("records only a real picker operation, never a restore or a capability limit", () => {
    const controller = bodyAt("const picker = createAiConversationPickerController({");
    expect(controller).toContain("onUserSelection: (selection) => {");
    expect(controller).toContain("conversationPickerSelections.set(pickerSelectionKey(), selection);");
    // A pick on an existing conversation must reach disk immediately: closing the
    // panel unmounts the component and drops the in-memory map.
    expect(controller).toContain("if (conversationId.value) void persistConversation();");

    // Capability limits go through `applyCapabilities`, which only shapes what is
    // shown; `restore` never calls the recording hook.
    expect(bodyAt("function restoreConversationPicker(conv: AiConversation)")).toContain("applyCapabilities(pending, pickerAmbient())");
    expect(rules).toContain('if (ambient.vectorDb) action = "generate";');
    expect(controllerSource).toContain("function setPair(desired: AiPickerSelection, recorded?: AiPickerSelection) {");
    expect(controllerSource).toContain("if (recorded) options.onUserSelection?.(recorded);");
  });

  it("persists the RECORDED pair with the conversation, not the constrained one", () => {
    const snapshot = bodyAt("function pickerSnapshotFor(");
    expect(snapshot).toContain("conversationPickerSelections.get(targetConversationId)");
    expect(snapshot).toContain("return { assistantMode: existing?.assistantMode, assistantAction: existing?.assistantAction };");
    // The raw source, reused by every path that rewrites a whole record.
    expect(bodyAt("function buildConversationSnapshot(")).toContain("...pickerSnapshotFor(targetConversationId),");
    expect(bodyAt("async function persistPendingInputRecovery(")).toContain("...pickerSnapshotFor(conversation.id),");
  });

  it("moves an unsaved chat's selection onto the id it adopts, in the same tick as send (R4)", () => {
    const migrate = bodyAt("function migrateUnsavedPickerSelection(id: string)");
    expect(migrate).toContain("conversationPickerSelections.delete(unsavedKey);");
    expect(migrate).toContain("conversationPickerSelections.set(id, selection);");
    const watcher = bodyAt("watch(conversationId, (id, previous) => {");
    expect(watcher).toContain("migrateUnsavedPickerSelection(id);");
    // A draft can never be reopened, so its state moves only onto an id this panel
    // minted — never onto a record that already exists, which is what a switch to
    // a conversation from the history list looks like (#12075 review).
    expect(watcher).toContain("if (conversations.value.some((conversation) => conversation.id === id)) return;");
    // `send()` mints the id and reads the selection before the watcher flushes,
    // and it only does so on a mint — never for an id that already has a record.
    const send = bodyAt("async function send()");
    expect(send).toContain("const mintedConversationId = !auto && !conversationId.value;");
    expect(send).toContain("if (mintedConversationId) {");
    expect(send).toContain("migrateUnsavedPickerSelection(conversationId.value);");
    // Queued input takes the same route when it mints the id itself.
    expect(bodyAt("function queueInput()")).toContain("migrateUnsavedPickerSelection(conversationId.value);");
  });

  it("abandons a draft's state instead of carrying it into the next conversation", () => {
    const discard = bodyAt("function discardUnsavedDraftState()");
    expect(discard).toContain("conversationPickerSelections.delete(unsavedKey);");
    expect(discard).toContain("conversationLoadedSkillIds.delete(unsavedKey);");
    expect(discard).toContain("unsavedConversationKey.value = `unsaved:${uuid()}`;");
    // A replaced draft (new chat) and an abandoned one (opening a stored
    // conversation) both go through the same drop, so the two cannot drift.
    expect(bodyAt("function clearMessages()")).toContain("discardUnsavedDraftState();");
    expect(bodyAt("function selectConversation(conv: AiConversation)")).toContain("if (!conversationId.value) discardUnsavedDraftState();");
  });

  it("drops a deleted conversation's selection with the rest of its state", () => {
    expect(bodyAt("async function performDeleteConversation(id: string)")).toContain("conversationPickerSelections.delete(id);");
  });

  it("routes every picker entry point through the controller", () => {
    // Mode tab, action item, slash command, the "Auto · <action>" chip, the
    // "Fix with AI" trigger and the plugin request all move the pair together.
    expect(bodyAt('function switchModeActionTab(mode: "ask" | "agent")')).toContain("picker.selectMode(mode);");
    expect(bodyAt("function selectAction(action: AiActionSelection)")).toContain("picker.selectAction(action);");
    expect(bodyAt("function switchToRoutedAction(action: AiAction | null | undefined)")).toContain("picker.select({");
    expect(bodyAt("function triggerAction(action: AiAction, instruction?: string)")).toContain("picker.select({");
    expect(bodyAt("function openPluginConversation(request: AiPluginConversationRequest)")).toContain("picker.select({");
    // The bare refs are no longer written outside the controller, and the
    // hand-rolled reset handshake is gone with them.
    expect(source).not.toContain("activeAction.value = resolveDefaultActionSelection");
    expect(source).not.toContain("suppressModeActionReset");
  });

  it("re-derives the shown pair when a capability comes or goes, instead of degrading one way", () => {
    // A capability limit belongs to `effective`, so it has to be recomputed from
    // the conversation's recording when the environment changes. The one-way
    // downgrades that used to live here stranded the panel on the degraded value:
    // `send()` reads the shown mode, so a connection that merely blipped kept an
    // Agent conversation sending as Ask.
    expect(bodyAt("function reapplyPickerCapabilities()")).toContain("resolveConversationPicker(pickerRecordFor(conversation), pickerAmbient()).effective");
    expect(bodyAt("function reapplyPickerCapabilities()")).toContain("applyCapabilities(pending, pickerAmbient())");
    // The capability watch is `immediate`, so it is declared below the
    // per-conversation key maps it reads (a TDZ otherwise).
    expect(source).toContain("watch([pluginContext, boundConnection], () => reapplyPickerCapabilities(), { immediate: true });");
    // Nothing writes the pair outside the controller — not even a capability.
    expect(source).not.toMatch(/\bassistantMode\.value = /);
    expect(source).not.toMatch(/\bactiveAction\.value = /);
  });
});
