import type { ForeignKeyInfo } from "@/types/database";

export interface TableWithFk {
  name: string;
  schema?: string | null;
  foreignKeys: ForeignKeyInfo[];
}

/**
 * Sort tables by foreign key dependency so that referencing tables
 * (those with an FK pointing to another table in the list) come before
 * the tables they reference.
 *
 * Uses Kahn's algorithm for topological sort. Falls back to original
 * order when a cycle is detected.
 */
export function sortTablesByFkDependency(tables: TableWithFk[]): TableWithFk[] {
  if (tables.length <= 1) return tables;

  const nameSet = new Set(tables.map((t) => t.name));
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const table of tables) {
    if (!adjacency.has(table.name)) adjacency.set(table.name, []);
    if (!inDegree.has(table.name)) inDegree.set(table.name, 0);
  }

  // Build dependency graph: an edge A → B means A references B,
  // so A should be dropped before B.
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      if (nameSet.has(fk.ref_table)) {
        // A → B: A depends on B, drop A first
        adjacency.get(table.name)!.push(fk.ref_table);
        inDegree.set(fk.ref_table, (inDegree.get(fk.ref_table) ?? 0) + 1);
      }
    }
  }

  // Kahn topological sort
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sortedNames: string[] = [];
  while (queue.length > 0) {
    // Sort queue for deterministic output; preserves original order
    // among nodes with equal in-degree.
    queue.sort((a, b) => {
      const ia = tables.findIndex((t) => t.name === a);
      const ib = tables.findIndex((t) => t.name === b);
      return ia - ib;
    });
    const current = queue.shift()!;
    sortedNames.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If not all nodes sorted, cycle detected — fall back to original order
  if (sortedNames.length !== tables.length) {
    return tables;
  }

  const nameToTable = new Map(tables.map((t) => [t.name, t]));
  return sortedNames.map((name) => nameToTable.get(name)!);
}
