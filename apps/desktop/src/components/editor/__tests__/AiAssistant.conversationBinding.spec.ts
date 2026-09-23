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
// AiAssistant.vue is a ~6000-line SFC the suite never mounts, so these
// assertions pin the wiring as text, matching the house source-assertion style
// used by AiAssistant.chatTitle.spec.ts. The binding *rules* themselves are
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

  it("persists a rebind onto the conversation record", () => {
    const body = bodyOf("async function rebindConversation(");

    expect(body).toContain("connectionId: connection.id");
    expect(body).toContain("saveAiConversation(updated)");
    // A chat that has no record yet stages the choice until its first snapshot.
    expect(body).toContain("draftBinding.value =");
  });

  it("resets the composer's database selection when the conversation changes", () => {
    // The key must include the conversation id: `selectedDatabases` is one ref
    // for the whole panel, so a key without it kept the previous chat's
    // database selected — the "bound database is not isolated" report.
    const watcherStart = source.indexOf("watch(\n  () => `${boundConnectionId.value}");
    expect(watcherStart).toBeGreaterThanOrEqual(0);
    const watcher = source.slice(watcherStart, source.indexOf(");", watcherStart));
    expect(watcher).toContain("conversationId.value");
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

  it("clears a staged draft binding when the shown chat changes", () => {
    expect(bodyOf("function selectConversation(conv: AiConversation)")).toContain("draftBinding.value = null;");
    expect(bodyOf("function clearMessages()")).toContain("draftBinding.value = null;");
  });

  it("shows the composer's connection and schema selectors from the binding", () => {
    expect(source).toContain(':model-value="boundConnectionId"');
    expect(source).toContain(":model-value=\"boundSchema || ''\"");
    expect(source).not.toContain(":model-value=\"connection?.id || ''\"");
  });

  it("labels each history row with the connection it is bound to", () => {
    // Which database a conversation talks to has to be readable without opening
    // it — the binding is per conversation, and several can be live at once.
    expect(source).toContain("{{ conv.connectionName }}");
    expect(source).toContain("conversationRowDetail(conv).connectionMissing");
    expect(bodyOf("function conversationRowDetail(conv: AiConversation)")).toContain("connectionMissing: !!conv.connectionId && !connectionStore.getConfig(conv.connectionId)");
  });

  it("retargets the conversation on a cross-connection table drop too", () => {
    // Reverses the old "reject a foreign table" contract: with the conversation
    // owning its binding, the drop can retarget it instead of being discarded.
    const start = source.indexOf("function onTableReferenceDropEvent");
    const body = source.slice(start, source.indexOf("\n}", start));

    expect(body).toContain("void bindConversation({ connectionId: payload.connectionId, database: payload.database, schema: payload.schema })");
    expect(body).toContain("addSelectedMention(");
    expect(body).not.toContain("context:");
  });

  it("retargets the conversation when a table is picked from another connection", () => {
    // Sliced between anchors rather than via bodyOf(): the parameter's
    // `{ schema?: string; table: string }` annotation is the first "{" after the
    // signature, so bodyOf would return the type, not the function body.
    const start = source.indexOf("function addTableMention(");
    const body = source.slice(start, source.indexOf("function clearContextReferences", start));

    expect(body).toContain("void bindConversation(binding)");
    expect(body).toContain("addSelectedMention(");

    const apply = bodyOf("async function bindConversation(binding: AiConversationBinding)");
    // The previous target's mentions and schema options no longer apply...
    expect(apply).toContain("clearContextReferences();");
    // ...and the new target goes onto the conversation, never the editor.
    expect(apply).toContain("rebindConversation(connection, binding.database, binding.schema)");
    expect(apply).not.toContain("queryStore.");
    expect(apply).not.toContain("activeConnectionId");
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

  it("compares the whole namespace when deciding whether to retarget", () => {
    // Comparing only the connection id would treat db1 -> db2 on one server as
    // "no change" and skip the rebind.
    const body = bodyOf("async function bindConversation(binding: AiConversationBinding)");
    expect(body).toContain("sameConversationBinding(binding, conversationBinding.value)");
    expect(body).not.toContain("binding.connectionId === boundConnectionId.value");
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

  it("keeps the snapshot's connection name and id on the same source", () => {
    // Taking the name from the caller (a run, so connection A) while the id comes
    // from the conversation record (B after a mid-run rebind) would save a
    // record that displays A but targets B.
    const body = bodyOf("function buildConversationSnapshot(");
    expect(body).toContain("connectionName: binding.connectionId ? (connectionStore.getConfig(binding.connectionId)?.name ?? connectionName) : connectionName,");
    expect(body).toContain("connectionId: binding.connectionId,");
    // The caller-supplied name is only a fallback now, never stored bare next to
    // an id taken from a different source.
    expect(body).toContain(": connectionName," + String.fromCharCode(10));
  });

  it("uses a run's frozen target for the first desktop snapshot", () => {
    const persist = bodyOf("async function persistDesktopRunSnapshot(run: DesktopAiRunRuntime<ChatMessage>)");
    expect(persist).toContain("{ connectionId: run.connectionId, database: run.database, schema: run.schema }");
    const snapshot = bodyOf("function buildConversationSnapshot(");
    expect(snapshot).toContain("snapshotBinding(targetConversationId, fallbackBinding)");
    expect(snapshot).toContain("schema: binding.schema");
    // Leaving the new chat also invokes this ordinary save path before the
    // run's scheduled snapshot; it must use the active run's target too.
    expect(bodyOf("async function persistConversation()")).toContain("const binding = activeRunBinding.value;");
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
