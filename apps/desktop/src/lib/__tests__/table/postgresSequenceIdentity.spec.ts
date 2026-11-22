import { describe, expect, it } from "vitest";
import { pinnedTreeNodeOrderKeyMatchesNode, treeNodePinIdentity, treeNodePinKey } from "@/lib/app/pinnedItems";
import { buildObjectBrowserRows, objectBrowserRowMatchesPinnedTreeNode, objectBrowserRowPinnedTreeNodeIdentity } from "@/lib/table/objectBrowserRows";
import { buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes } from "@/lib/table/tableTree";

const objects = [
  { name: ' seq"name ', schema: ' Owner"Name ', object_type: "SEQUENCE" },
  { name: 'seq"name', schema: ' Owner"Name ', object_type: "SEQUENCE" },
];
const context = { nodeId: "root", connectionId: "pg", database: "db", schema: "public", databaseType: "postgres" as const, objects };

describe("PostgreSQL sequence edit targets", () => {
  it("preserves exact edit identities separately from browser display names", () => {
    const rows = buildObjectBrowserRows({ ...context, fallbackSchema: "public" });
    expect(rows.map((row) => row.displayName)).toEqual(['seq"name', 'seq"name']);
    expect(rows.map((row) => row.postgresSequenceIdentity)).toEqual(objects.map(({ name, schema }) => ({ name, schema })));
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it.each(["simple", "grouped"])("retains whitespace-distinct sequences in the %s sidebar", (layout) => {
    const nodes = layout === "simple" ? buildSimpleObjectTreeNodes(context) : buildGroupedObjectTreeNodes(context).find((node) => node.type === "group-sequences")!.children!;
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.postgresSequenceExactIdentity === true)).toBe(true);
    expect(nodes.map((node) => node.label)).toEqual(['seq"name', 'seq"name']);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    expect(nodes.map((node) => ({ name: node.objectName, schema: node.schema }))).toEqual(objects.map(({ name, schema }) => ({ name, schema })));
  });

  it.each(["simple", "grouped"])("synchronizes exact sequence pins between the browser and %s sidebar", (layout) => {
    const pinObjects = [...objects, { name: 'seq"name', schema: 'Owner"Name', object_type: "SEQUENCE" }];
    const pinContext = { ...context, objects: pinObjects };
    const rows = buildObjectBrowserRows({ ...pinContext, fallbackSchema: "public" });
    const nodes = layout === "simple" ? buildSimpleObjectTreeNodes(pinContext) : buildGroupedObjectTreeNodes(pinContext).find((node) => node.type === "group-sequences")!.children!;

    for (const row of rows) {
      const identity = objectBrowserRowPinnedTreeNodeIdentity(row, pinContext);
      const browserNode = { id: row.id, type: identity.type, label: row.displayName, objectName: identity.name, schema: identity.schema, connectionId: identity.connectionId, database: identity.database };
      const key = treeNodePinKey(browserNode);
      for (const node of nodes) {
        const sameSequence = node.objectName === row.postgresSequenceIdentity!.name && node.schema === row.postgresSequenceIdentity!.schema;
        expect(objectBrowserRowMatchesPinnedTreeNode(row, treeNodePinIdentity(node), pinContext)).toBe(sameSequence);
        expect(pinnedTreeNodeOrderKeyMatchesNode(key, node)).toBe(sameSequence);
      }
    }
  });

  it("does not change normalization or advertise exact PG identities for other engines", () => {
    const rows = buildObjectBrowserRows({ ...context, databaseType: "opengauss", fallbackSchema: "public" });
    expect(rows.every((row) => row.postgresSequenceIdentity === undefined)).toBe(true);
    expect(rows.map((row) => row.name)).toEqual(['seq"name', 'seq"name']);
    const nodes = buildSimpleObjectTreeNodes({ ...context, databaseType: "opengauss" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].postgresSequenceExactIdentity).toBeUndefined();
    expect(nodes[0]).toMatchObject({ objectName: 'seq"name', schema: 'Owner"Name' });
  });
});
