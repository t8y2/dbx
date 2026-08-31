import { qualifiedTableKey } from "./docsKeys";
import type { DocTable, SchemaSnapshot } from "./types";

export interface IndexSection {
  /** Schema name, group id, or "" for the ungrouped bucket. */
  key: string;
  label: string;
  /**
   * Locale key to show in place of `label` when it's empty — "docs.noSchema"
   * from groupBySchema, "docs.noGroup" from groupByTableGroup. This module
   * stays translator-free (it is pure, tested without Vue, and every other
   * pure module in src/docs/ follows the same rule), so it hands back a KEY
   * rather than calling translate() itself; the render site decides how.
   *
   * Carrying the key on the section — rather than each render site inferring
   * it from a `mode` prop — means a fallback can never silently pick the
   * wrong word for the section it labels: WikiIndex.vue doesn't even receive
   * `mode`, so a mode-based guess there would either require threading a prop
   * that has no other use, or duplicate this same schema/group decision at a
   * second call site to keep in sync with this one.
   */
  fallbackKey: "docs.noSchema" | "docs.noGroup";
  /** Group hue, or null for schema sections and the ungrouped bucket. */
  hue: number | null;
  note: string | null;
  tables: DocTable[];
}

function byName(a: DocTable, b: DocTable): number {
  return a.name.localeCompare(b.name);
}

export function groupBySchema(snapshot: SchemaSnapshot): IndexSection[] {
  const sections = new Map<string, DocTable[]>();
  for (const table of snapshot.tables) {
    const key = table.schema ?? "";
    const bucket = sections.get(key);
    if (bucket) {
      bucket.push(table);
    } else {
      sections.set(key, [table]);
    }
  }

  return [...sections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, tables]) => ({
      key,
      label: key,
      fallbackKey: "docs.noSchema" as const,
      hue: null,
      note: null,
      tables: [...tables].sort(byName),
    }));
}

export function groupByTableGroup(snapshot: SchemaSnapshot): IndexSection[] {
  const known = new Map(snapshot.groups.map((group) => [group.id, group]));
  const sections: IndexSection[] = [];

  // Snapshot order is the notes file's order — the user's own arrangement.
  for (const group of snapshot.groups) {
    const tables = snapshot.tables.filter((table) => table.groupId === group.id).sort(byName);
    // An empty group renders nothing, matching render_group in the serializer.
    if (tables.length === 0) {
      continue;
    }
    sections.push({
      key: group.id,
      label: group.name,
      fallbackKey: "docs.noGroup",
      hue: group.hue,
      note: group.note,
      tables,
    });
  }

  // A groupId naming no known group is treated as ungrouped rather than
  // creating a phantom section.
  const ungrouped = snapshot.tables.filter((table) => table.groupId === null || !known.has(table.groupId)).sort(byName);

  if (ungrouped.length > 0) {
    // Empty, not "(no group)": the render sites already fall back to a
    // translated label when `label` is empty (see IndexSection.fallbackKey).
    // A non-empty English literal here would bypass that fallback entirely.
    sections.push({ key: "", label: "", fallbackKey: "docs.noGroup", hue: null, note: null, tables: ungrouped });
  }

  return sections;
}

/**
 * Every column whose declared type is this enum.
 *
 * Exact match on `data_type`, never a substring: an enum named `state` would
 * otherwise claim every column of type `statement`.
 */
export function columnsUsingEnum(snapshot: SchemaSnapshot, enumName: string): Array<{ tableKey: string; table: string; column: string }> {
  const hits: Array<{ tableKey: string; table: string; column: string }> = [];
  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      if (column.data_type === enumName) {
        hits.push({ tableKey: qualifiedTableKey(table), table: table.name, column: column.name });
      }
    }
  }
  return hits;
}
