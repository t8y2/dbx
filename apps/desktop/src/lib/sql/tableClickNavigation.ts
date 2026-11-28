import type { ObjectSourceKind } from "@/types/database";

/** The two states of the "Ctrl+Click Table Opens DDL" navigation setting. */
export type TableClickNavigationSetting = "data" | "ddl";

/**
 * What a Ctrl/Cmd+click on an object in the SQL editor should do.
 *
 * - `data`: open the object's data view.
 * - `dialog`: open the definition/source dialog for `objectType`.
 */
export type TableClickAction = { kind: "data" } | { kind: "dialog"; objectType: ObjectSourceKind };

/**
 * Views and materialized views have both a definition and a data surface, so
 * they follow the navigation setting: `ddl` opens the definition dialog,
 * `data` opens the data view. Every other source kind (sequence, synonym,
 * trigger, ...) has no data surface and keeps opening its definition dialog,
 * which is also the historical behavior. Objects without a source kind are
 * plain tables and always open their data view.
 */
export function resolveTableClickAction(sourceKind: ObjectSourceKind | undefined, setting: TableClickNavigationSetting): TableClickAction {
  if (!sourceKind) return { kind: "data" };
  if (sourceKind === "VIEW" || sourceKind === "MATERIALIZED_VIEW") {
    return setting === "ddl" ? { kind: "dialog", objectType: sourceKind } : { kind: "data" };
  }
  return { kind: "dialog", objectType: sourceKind };
}
