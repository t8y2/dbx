// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { handleAiTableReferenceDropEvent, type AiTableReferenceDropContext } from "@/lib/ai/aiTableReferenceDrop";
import { createTableReferenceDropEvent, createTableReferencePayload, DBX_TABLE_REFERENCE_DROP_EVENT, type QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";

function dispatchTableReferenceDrop(payload: QueryEditorTableReferencePayload, context: AiTableReferenceDropContext) {
  const assistantRoot = document.createElement("div");
  const target = document.createElement("span");
  assistantRoot.append(target);
  document.body.append(assistantRoot);
  const mentions: string[] = [];
  const listener = (event: Event) => {
    handleAiTableReferenceDropEvent(event, {
      context,
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
  it("accepts a table dropped from the active connection and database", () => {
    expect(dispatchTableReferenceDrop(tablePayload(), { connectionId: "conn-1", database: "app-db" })).toEqual(["@public.users"]);
  });

  it("rejects a table dropped from another connection", () => {
    expect(dispatchTableReferenceDrop(tablePayload({ connectionId: "conn-2" }), { connectionId: "conn-1", database: "app-db" })).toEqual([]);
  });

  it("rejects a table dropped from another database", () => {
    expect(dispatchTableReferenceDrop(tablePayload({ database: "analytics" }), { connectionId: "conn-1", database: "app-db" })).toEqual([]);
  });
});
