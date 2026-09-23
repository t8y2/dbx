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
    const productionStart = source.indexOf("const productionContext = computed");
    expect(productionStart).toBeGreaterThanOrEqual(0);
    const production = source.slice(productionStart, source.indexOf("});", productionStart));
    expect(production).toContain("boundConnection.value");
    expect(production).not.toContain("props.connection");
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

    expect(body).toContain("const runBinding = auto ? auto.binding : conversationBinding.value;");
    expect(body).toContain("aiContextTargetFor(runBinding, props.tab)");
    // A background send has no composer of its own, so its database selection is
    // the conversation's own database rather than the visible composer's.
    expect(body).toContain("auto ? [runBinding.database] : [...selectedDatabases.value]");
    // Nothing in the run pipeline may read the live binding: a rebind mid-flight
    // would otherwise redirect the run's own SQL to the new connection.
    expect(body).not.toContain("boundConnection.value");
    expect(body).not.toMatch(/emit\("requestAutoExecuteSql", agentPlan\.handoffSql, conversationBinding\.value\)/);
    expect(body).toContain('emit("requestAutoExecuteSql", agentPlan.handoffSql, runBinding)');
  });

  it("compares the whole namespace when deciding whether to retarget", () => {
    // Comparing only the connection id would treat db1 -> db2 on one server as
    // "no change" and skip the rebind.
    const body = bodyOf("async function bindConversation(binding: AiConversationBinding)");
    expect(body).toContain("sameConversationBinding(binding, conversationBinding.value)");
    expect(body).not.toContain("binding.connectionId === boundConnectionId.value");
  });
});
