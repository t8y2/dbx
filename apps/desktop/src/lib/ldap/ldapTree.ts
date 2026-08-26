/**
 * LDAP entry tree structure.
 *
 * LDAP Distinguished Names (DNs) use comma-separated RDN components
 * like "OU=CLIENTS,DC=CORP,DC=INT,DC=KN". This module splits on "," and
 * builds a hierarchical tree suitable for a sidebar / tree-view browser.
 */

export interface LdapEntrySummary {
  dn: string;
  attributes: Record<string, string | string[]>;
}

/** A single entry (leaf) in the LDAP tree. */
export interface LdapTreeLeafNode {
  kind: "leaf";
  id: string;
  label: string;
  dn: string;
  pathSegments: string[];
  attributes: Record<string, string | string[]>;
}

/** An intermediate DN component (group). */
export interface LdapTreeGroupNode {
  kind: "group";
  id: string;
  label: string;
  pathSegments: string[];
  children: LdapTreeNode[];
}

export type LdapTreeNode = LdapTreeLeafNode | LdapTreeGroupNode;

export interface LdapTreeRow {
  node: LdapTreeNode;
  depth: number;
}

/**
 * Split a DN into RDN components in display order
 * (most-specific first → least-specific last).
 *
 * "OU=Users,DC=corp,DC=com" → ["DC=com", "DC=corp", "OU=Users"]
 * (reversed so the tree root is the domain components).
 */
function dnSegments(dn: string): string[] {
  // Simple comma-split — for production you may want a proper DN parser
  // that handles escaped commas (\2C) and quoted values.
  return dn
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
}

function groupId(pathSegments: string[]): string {
  return `ldap-group:${pathSegments.join("\u0000")}`;
}

function leafId(dn: string): string {
  return `ldap-leaf:${dn}`;
}

function sortNodes(nodes: LdapTreeNode[]): LdapTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
      return a.label.localeCompare(b.label);
    })
    .map((node) => (node.kind === "group" ? { ...node, children: sortNodes(node.children) } : node));
}

/**
 * Build a hierarchical tree from a flat list of LDAP entries.
 * Entries with shorter DNs appear closer to the root.
 */
export function buildLdapTree(entries: LdapEntrySummary[]): LdapTreeNode[] {
  const root: LdapTreeNode[] = [];
  const groups = new Map<string, LdapTreeGroupNode>();

  for (const entry of entries) {
    const segments = dnSegments(entry.dn);
    // Use the last RDN (most-specific) as the label
    const label = segments.length > 0 ? segments[segments.length - 1] : entry.dn;

    if (segments.length <= 1) {
      root.push({
        kind: "leaf",
        id: leafId(entry.dn),
        label,
        dn: entry.dn,
        pathSegments: segments,
        attributes: entry.attributes,
      });
      continue;
    }

    // Walk segments to insert into the tree
    let current = root;
    const groupSegments: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      groupSegments.push(segment);
      const id = groupId(groupSegments);
      let group = groups.get(id);
      if (!group) {
        group = {
          kind: "group",
          id,
          label: segment,
          pathSegments: [...groupSegments],
          children: [],
        };
        groups.set(id, group);
        current.push(group);
      }
      current = group.children;
    }

    // Insert the leaf
    current.push({
      kind: "leaf",
      id: leafId(entry.dn),
      label,
      dn: entry.dn,
      pathSegments: segments,
      attributes: entry.attributes,
    });
  }

  return sortNodes(root);
}

/**
 * Flatten the tree into a list of rows with depth for virtual-scroll rendering.
 */
export function flattenLdapTree(nodes: LdapTreeNode[], expandedIds: Set<string>): LdapTreeRow[] {
  const rows: LdapTreeRow[] = [];
  function walk(nodes: LdapTreeNode[], depth: number) {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "group" && expandedIds.has(node.id) && node.children.length > 0) {
        walk(node.children, depth + 1);
      }
    }
  }
  walk(nodes, 0);
  return rows;
}
