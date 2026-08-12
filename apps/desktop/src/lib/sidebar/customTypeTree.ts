import type { CustomTypeDetails, CustomTypeTreeMemberMeta, TreeNode } from "@/types/database";

function encodeMemberIdentity(value: string): string {
  return encodeURIComponent(value);
}

function typeMemberNode(parent: TreeNode, identity: string, label: string, meta: CustomTypeTreeMemberMeta): TreeNode {
  return {
    id: `${parent.id}:type-member:${meta.kind}:${encodeMemberIdentity(identity)}`,
    label,
    type: "type-member",
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
    catalog: parent.catalog,
    objectName: parent.objectName || parent.label,
    meta,
  };
}

export function buildCustomTypeTreeChildren(parent: TreeNode, details: CustomTypeDetails): TreeNode[] {
  if (details.kind === "composite") {
    return details.members.map((member) =>
      typeMemberNode(parent, member.name, member.name, {
        kind: "field",
        displayValue: member.dataType,
        ordinal: member.ordinal,
      }),
    );
  }

  if (details.kind === "enum") {
    return details.members.map((member) =>
      typeMemberNode(parent, member.enumValue || member.name, member.enumValue || member.name, {
        kind: "enum-value",
        ordinal: member.ordinal,
      }),
    );
  }

  return [];
}
