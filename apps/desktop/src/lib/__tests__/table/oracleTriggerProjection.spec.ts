import { describe, expect, it } from "vitest";
import type { ObjectInfo, TriggerInfo, TableStructureEditorDraft } from "@/types/database";
import { createTriggerDrafts } from "@/lib/table/tableStructureEditorState";
import { reconcileOracleTriggerStructureDraft } from "@/lib/database/oracleTriggerStructurePlan";
import { buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes, tablePageRowAnchorKey } from "@/lib/table/tableTree";
import { buildObjectBrowserRows, objectBrowserRowMatchesPinnedTreeNode, objectBrowserRowPinnedTreeNodeIdentity } from "@/lib/table/objectBrowserRows";
import { exactOracleTriggerNodeMetadata, oracleTriggerIdentityKey, oracleTriggerObjectReadOptions } from "@/lib/database/oracleTriggerIdentity";

function object(name = ' Tr:ig" ', owner = " Owner: ", id = "9007199254740993", scope: "VIEW" | "SCHEMA" = "VIEW"): ObjectInfo {
  const trigger: TriggerInfo = {
    name,
    event: "UPDATE",
    timing: "INSTEAD OF",
    enabled: true,
    valid: false,
    oracle_metadata: {
      contractVersion: 1,
      identityMode: "exact",
      engine: "oracle",
      owner,
      name,
      objectId: id,
      scope,
      ...(scope === "VIEW" ? { parent: { owner: " Parent Owner ", name: ' Parent" ', objectType: "VIEW" } } : { scopeOwner: " Scope Owner " }),
      reads: { identity: { state: "available" } },
    },
  };
  return { name, schema: owner, object_type: "TRIGGER", parent_schema: "must-not-be-used", parent_name: "wrong-parent", trigger };
}

describe("Oracle-family exact trigger projections", () => {
  it("gives same-name triggers distinct owner-bound structure IDs while retaining legacy IDs", () => {
    const [a, b] = createTriggerDrafts([object("T", "A").trigger!, object("T", "B").trigger!]);
    expect(a.id).not.toBe(b.id);
    expect(createTriggerDrafts([{ name: "T", event: "INSERT", timing: "BEFORE" }])[0].id).toBe("existing:T");
  });

  it.each([
    ["T", "B"],
    [" T ", "A"],
    ["t", "A"],
  ])("reconciles raw identity %s / %s separately without changing another trigger's draft", (secondName, secondOwner) => {
    const originals = [object("T", "A", "a-id").trigger!, object(secondName, secondOwner, "b-id").trigger!];
    const triggers = createTriggerDrafts(originals).map((trigger, index) => ({ ...trigger, id: `owner-${index}`, enabled: index === 0 ? false : trigger.enabled }));
    const draft = { columns: [], indexes: [], foreignKeys: [], triggers, tableComment: "", originalTableComment: "" } as TableStructureEditorDraft;
    const next = reconcileOracleTriggerStructureDraft(draft, { columns: [], indexes: [], foreignKeys: [], triggers: structuredClone(originals), constraints: [], comment: "" }, { columns: new Set(), indexes: new Set(), foreignKeys: new Set(), triggers: new Set([triggers[0].id]) }, "oracle");
    expect(next.triggers).toHaveLength(2);
    expect(next.triggers.find((trigger) => trigger.id === "owner-0")).toMatchObject({ enabled: false, original: { oracle_metadata: { owner: "A", objectId: "a-id" } } });
    expect(next.triggers.find((trigger) => trigger.id === "owner-1")).toMatchObject({ original: { oracle_metadata: { owner: secondOwner, name: secondName, objectId: "b-id" } } });
  });
  it("does not extract a target from a label or contradicting node identity", () => {
    const nodes = buildSimpleObjectTreeNodes({ nodeId: "n", connectionId: "c", database: "d", objects: [object()] });
    expect(exactOracleTriggerNodeMetadata(nodes[0])).toEqual(object().trigger!.oracle_metadata);
    expect(exactOracleTriggerNodeMetadata({ ...nodes[0], objectName: undefined })).toBeUndefined();
    expect(exactOracleTriggerNodeMetadata({ ...nodes[0], schema: "Owner:" })).toBeUndefined();
    expect(exactOracleTriggerNodeMetadata({ ...nodes[0], meta: undefined })).toBeUndefined();
  });

  it("uses encoded tuples rather than ambiguous display delimiters", () => {
    expect(oracleTriggerIdentityKey({ owner: "A:B", name: "C" })).not.toBe(oracleTriggerIdentityKey({ owner: "A", name: "B:C" }));
    expect(oracleTriggerIdentityKey({ owner: "A", name: " C " })).not.toBe(oracleTriggerIdentityKey({ owner: "A", name: "C" }));
    expect(oracleTriggerIdentityKey({ owner: "A", name: "C" }, "D")).not.toBe(oracleTriggerIdentityKey({ owner: "A", name: "C" }));
  });

  it("adds read prerequisites to new trigger usage without changing old unknown-JDBC mixed reads", () => {
    const unknown = { db_type: "jdbc" as const, driver_label: "Oracle-compatible Yashan", database_info: { productName: "YashanDB" } };
    expect(oracleTriggerObjectReadOptions(unknown)).toBeUndefined();
    expect(oracleTriggerObjectReadOptions(unknown, ["TABLE", "TRIGGER"])).toBeUndefined();
    expect(oracleTriggerObjectReadOptions(unknown, ["TRIGGER"])).toEqual({ identityMode: "exact" });
    expect(oracleTriggerObjectReadOptions({ ...unknown, database_info: { productName: "Oracle" } })).toEqual({ identityMode: "exact" });
    expect(oracleTriggerObjectReadOptions({ db_type: "oracle" }, [])).toBeUndefined();
    expect(oracleTriggerObjectReadOptions({ db_type: "oracle" }, ["PROCEDURE"])).toBeUndefined();
    expect(oracleTriggerObjectReadOptions({ db_type: "mysql" }, ["TRIGGER"])).toBeUndefined();
  });

  for (const layout of ["simple", "grouped"] as const) {
    it(`${layout} preserves raw trigger and independent parent identity without merging approximate names`, () => {
      const objects = [object(), object('Tr:ig"'), object(' Tr:ig" ', " owner: ")];
      const context = { nodeId: "c:d:s", connectionId: "c", database: "d", schema: "execution", catalog: " Catalog ", objects };
      const nodes = layout === "simple" ? buildSimpleObjectTreeNodes(context) : buildGroupedObjectTreeNodes(context).find((group) => group.type === "group-triggers")!.children!;
      expect(nodes).toHaveLength(3);
      expect(new Set(nodes.map((node) => node.id)).size).toBe(3);
      const raw = nodes.find((node) => node.schema === " Owner: " && node.objectName === ' Tr:ig" ')!;
      expect(raw).toMatchObject({ schema: " Owner: ", objectName: ' Tr:ig" ', catalog: " Catalog ", parentSchema: " Parent Owner ", parentName: ' Parent" ', parentType: "view", tableName: ' Parent" ', valid: false, meta: objects[0].trigger });
      expect(raw.partitionParentName).toBeUndefined();
    });

    it(`${layout} shows non-table scope without a fabricated owning table`, () => {
      const context = { nodeId: "c:d:s", connectionId: "c", database: "d", schema: "execution", objects: [object(" Schema Trigger ", " Owner ", "3", "SCHEMA")] };
      const nodes = layout === "simple" ? buildSimpleObjectTreeNodes(context) : buildGroupedObjectTreeNodes(context)[0].children!;
      expect(nodes[0].objectName).toBe(" Schema Trigger ");
      expect(nodes[0].parentName).toBeUndefined();
      expect(nodes[0].tableName).toBeUndefined();
    });
  }

  it("object-browser rows retain the same metadata instead of projecting trigger parents as partitions", () => {
    const objects = [object(), object('Tr:ig"'), object(" Schema Trigger ", " Owner ", "3", "SCHEMA")];
    const rows = buildObjectBrowserRows({ objects, database: "d", fallbackSchema: "execution" });
    expect(rows.map((row) => row.name)).toEqual(objects.map((entry) => entry.name));
    expect(rows[0]).toMatchObject({ schema: " Owner: ", valid: false, trigger: objects[0].trigger });
    expect(rows.every((row) => row.partitionParentName === undefined && row.partitionParentSchema === undefined)).toBe(true);
  });

  it("page anchors distinguish quoted names, owners and same-name object recreation", () => {
    const first = object();
    const second = object('Tr:ig"', " owner: ");
    const recreated = object(first.name, first.schema!, "99");
    const anchor = (entry: ObjectInfo) => tablePageRowAnchorKey(entry.name, entry.schema, entry.parent_name, entry.trigger);
    expect(anchor(first)).not.toBe(anchor(second));
    expect(anchor(first)).not.toBe(anchor(recreated));
    expect(tablePageRowAnchorKey("TABLE", "APP")).toBe(tablePageRowAnchorKey("table", "app"));
  });

  it("pins use the exact owner even when it equals the database display alias", () => {
    const context = { connectionId: "c", database: "d", catalog: " Catalog ", schema: "execution" };
    const [row] = buildObjectBrowserRows({ objects: [object(" Trigger ", "d")], database: "d", fallbackSchema: "execution" });
    const identity = objectBrowserRowPinnedTreeNodeIdentity(row, context);
    expect(objectBrowserRowMatchesPinnedTreeNode(row, identity, context)).toBe(true);
    expect(objectBrowserRowMatchesPinnedTreeNode(row, { ...identity, schema: "" }, context)).toBe(false);
    expect(objectBrowserRowMatchesPinnedTreeNode(row, { ...identity, name: "Trigger" }, context)).toBe(false);
    expect(objectBrowserRowMatchesPinnedTreeNode(row, { ...identity, catalog: "Catalog" }, context)).toBe(false);
  });
});
