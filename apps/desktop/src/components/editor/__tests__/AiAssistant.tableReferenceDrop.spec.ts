// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { handleAiTableReferenceDropEvent } from "@/lib/ai/aiTableReferenceDrop";
import { createTableReferenceDropEvent, createTableReferencePayload, DBX_TABLE_REFERENCE_DROP_EVENT, type QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";

function dispatchTableReferenceDrop(payload: QueryEditorTableReferencePayload) {
  const assistantRoot = document.createElement("div");
  const target = document.createElement("span");
  assistantRoot.append(target);
  document.body.append(assistantRoot);
  const mentions: string[] = [];
  const listener = (event: Event) => {
    handleAiTableReferenceDropEvent(event, {
      assistantRoot,
      elementFromPoint: () => target,
      onMention: (mention) => mentions.push(mention.raw),
    });
  };
  window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, listener);
  window.dispatchEvent(createTableReferenceDropEvent({ payload, clientX: 12, clientY: 24 }));
  window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, listener);
  return mentions;
}

function tablePayload(overrides: Partial<QueryEditorTableReferencePayload> = {}) {
  return createTableReferencePayload({
    connectionId: overrides.connectionId ?? "conn-1",
    database: overrides.database ?? "app-db",
    schema: "public",
    tableName: "users",
    databaseType: "postgres",
  })!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AI assistant table reference drop", () => {
  it("accepts a table dropped from the conversation's own connection and database", () => {
    expect(dispatchTableReferenceDrop(tablePayload())).toEqual(["@public.users"]);
  });

  // #9902 reversed the old "reject a foreign table" contract. It was correct
  // while the panel's connection was whatever editor tab was active — there was
  // nothing to retarget, so a foreign table had to be dropped. Now the
  // conversation owns its binding and the drop retargets it, so the mention is
  // accepted and resolved against the database it came from.
  it("accepts a table dropped from another connection, so the drop can retarget the conversation", () => {
    expect(dispatchTableReferenceDrop(tablePayload({ connectionId: "conn-2" }))).toEqual(["@public.users"]);
  });

  it("accepts a table dropped from another database on the same connection", () => {
    expect(dispatchTableReferenceDrop(tablePayload({ database: "analytics" }))).toEqual(["@public.users"]);
  });
});
