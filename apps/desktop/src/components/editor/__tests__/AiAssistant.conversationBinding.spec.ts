import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/9902:
//
// The AI panel used to take its connection from whatever editor tab was active
// (App.vue passes `:connection="activeConnection"` / `:tab="activeTab"` into a
// single, global panel), and `changeConnection()` even wrote the chosen
// connection back onto that tab — so every conversation shared one connection
// and the composer's database selection leaked between chats.
//
// AiAssistant.vue is a ~6000-line SFC the suite never mounts, so the checks
// that keep AI writes and runs on the bound connection pin the wiring as text
// until they have mounted coverage. The binding *rules* themselves are
// unit-tested in lib/ai/__tests__/aiConversationBinding.spec.ts.
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

describe("AI conversation owns its connection binding (#9902)", () => {
  it("rebinding the conversation never rewrites the editor tab or the global active connection", () => {
    const body = bodyOf("async function changeConnection(connectionId: string)");

    // These are the calls that made the binding global: they pushed the AI
    // panel's choice onto the tab the user was working in.
    expect(body).not.toContain("queryStore.updateConnection");
    expect(body).not.toContain("queryStore.updateSchema");
    expect(body).not.toContain("queryStore.updateDatabase");
    expect(body).not.toContain("queryStore.createTab");
    expect(body).not.toContain("connectionStore.activeConnectionId");
    // It writes the binding onto the conversation instead.
    expect(body).toContain("rebindConversation(");
  });

  it("sends against the bound connection, not the visible tab", () => {
    const body = bodyOf("async function send()");

    // The visible tab may contribute editor state, but only through
    // aiContextTargetFor(), which gates it on the same namespace; the target
    // itself always comes from the binding.
    expect(body).toContain("runBinding.connectionId ? connectionStore.getConfig(runBinding.connectionId) : undefined");
    expect(body).toContain("aiContextTargetFor(runBinding, props.tab)");
    expect(body).not.toContain("props.connection");
  });

  it("judges production write protection against the bound connection", () => {
    // Confirming a write against the bound database must not be vetted against
    // whichever tab happens to be visible.
    expect(source).toContain("return productionContextForDatabase(connection, target.database);");
    expect(source).toContain("const productionContext = computed(() => productionContextOf(activeRunBinding.value));");
  });

  it("freezes the binding for a background auto-send instead of reading the visible one", () => {
    // An auto-send for conversation A runs while B may be on screen, so it must
    // carry its own binding: reading the live one would target B's database.
    expect(source).toContain("binding: AiConversationBinding;");
    const schedule = bodyOf("function scheduleAutoSend(");
    expect(schedule).toContain("binding: bindingForSnapshot(conversations.value, convId, conversationBinding.value)");
  });

  it("derives a run's target from the frozen binding, not the live one", () => {
    const body = bodyOf("async function send()");

    // A confirmation resume continues an existing run, so the run's frozen
    // binding wins over the conversation's live one on that path too.
    expect(body).toContain("const runBinding = auto ? auto.binding : (confirmationTarget ?? resumableBinding ?? conversationBinding.value);");
    expect(body).toContain("aiContextTargetFor(runBinding, props.tab)");
    // A background send has no composer of its own, so its database selection is
    // the conversation's own database rather than the visible composer's.
    expect(body).toContain("auto || confirmationRetargets ? [runBinding.database] : [...selectedDatabases.value]");
    // Only a fresh send reads the live binding; actions emitted by this run
    // continue to carry the frozen `runBinding` after any rebind.
    expect(body).not.toContain("boundConnection.value");
    expect(body).not.toMatch(/emit\("requestAutoExecuteSql", agentPlan\.handoffSql, conversationBinding\.value\)/);
    expect(body).toContain('emit("requestAutoExecuteSql", agentPlan.handoffSql, runBinding)');
  });

  it("keeps the composer's own context unless the confirmation retargets", () => {
    // The composer is live while a card is up (`isGenerating` is already false),
    // so the user can attach a file and then confirm with "yes". Discarding that
    // context is only correct when the target actually moved: send() clears all
    // four arrays afterwards, so a drop here loses the attachment silently.
    const body = bodyOf("async function send()");

    expect(body).toContain("const confirmationRetargets = !!confirmationTarget && !sameConversationBinding(runBinding, conversationBinding.value);");
    for (const array of ["selectedTableMentions", "selectedSqlFiles", "csvAttachments", "imageAttachments"]) {
      const line = body.split("\n").find((l) => l.includes(`const ${array} = `)) ?? "";
      expect(line).toContain("confirmationRetargets");
      expect(line).toContain("? [] :");
      expect(line).not.toContain("confirmationTarget ?");
    }
  });

  it("judges production write protection and routing against the run's frozen binding", () => {
    // A run's target is frozen at send time, so a rebind mid-run (or while the
    // confirmation card is up) must not move the production verdict or the
    // routing context onto the new connection. Judging the live binding could
    // grant `allowWriteSql` for a production database.
    const runBinding = bodyOf("const activeRunBinding = computed");
    expect(runBinding).toContain("desktopAiRun<ChatMessage>(conversationId.value)");
    expect(runBinding).toContain("activeAiRunBinding(conversationBinding.value, run, messages.value");

    expect(source).toContain("const productionContext = computed(() => productionContextOf(activeRunBinding.value));");
    const productionOf = bodyOf("function productionContextOf(binding: AiConversationBinding)");
    expect(productionOf).toContain("resolveAiDatabaseTarget({ database: binding.database, schema: binding.schema }, connection)");
    expect(productionOf).not.toContain("boundDatabase");

    const route = bodyOf("async function resolveAutoAction(");
    expect(route).toContain("hasCurrentSql: !!target.sql?.trim()");
    expect(route).toContain("tabHasLastError(target)");
    expect(route).not.toContain("aiContextTarget.value.sql");
    // The send pipeline hands it the frozen run target it already computed.
    expect(bodyOf("async function send()")).toContain("resolveAutoAction(text, requestedMode, runIsVisible(), tab)");
  });

  it("confirms a proposed write against the run's binding, not the live one", () => {
    // The card belongs to a run. Rebinding while it is up must not append the
    // SQL to another connection, nor record the confirmation for one — the
    // backend verifies the confirmed namespace against the real execution
    // target, so a mismatch would also fail the confirmation.
    const body = bodyOf("function sendProposalReply(positive: boolean)");

    expect(body).toContain("const runBinding = activeRunBinding.value;");
    expect(body).toContain('emit("appendSql", sql, runBinding);');
    expect(body).toContain("confirmedConnectionId = runBinding.connectionId;");
    expect(body).toContain("resolveAiDatabaseTarget({ database: runBinding.database, schema: runBinding.schema }, runConnection)");
    expect(body).not.toContain("conversationBinding.value");
    expect(body).not.toContain("boundConnection.value");
    expect(body).not.toContain("boundDatabase.value");
    expect(body).toContain("confirmationBindingForNextRun = runBinding;");
  });

  it("persists the assistant turn's target for Web confirmation after remount", () => {
    expect(source).toContain("sourceBinding: runBinding");
    expect(bodyOf("function buildConversationSnapshot(")).toContain("sourceBinding: m.sourceBinding");
    expect(bodyOf("function chatMessagesFromConversation(conv: AiConversation)")).toContain("sourceBinding: m.sourceBinding ??");
    const sendBody = bodyOf("async function send()");
    expect(sendBody).toContain("typedConfirmationBinding");
    expect(sendBody).toContain("productionContextOf(runBinding).active");
  });
});
