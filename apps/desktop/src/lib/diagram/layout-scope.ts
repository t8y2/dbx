import type { DiagramTable, DiagramRelationship } from "./erDiagram";
import type { DiagramLayer } from "@/types/diagram";
import { diagramIdentityKey } from "./diagramMetadataLoader";

/** Capture a closed graph; neither hidden nor unloaded layer members may be reflowed. */
export function buildLayoutGraph(tables: DiagramTable[], relationships: DiagramRelationship[], layers: DiagramLayer[], keyOf: (table: DiagramTable) => string, focusedIdentities?: ReadonlySet<string>) {
  const eligible = tables.filter((table) => !focusedIdentities || focusedIdentities.has(diagramIdentityKey(table)));
  const keys = new Set(eligible.map(keyOf));
  return {
    tables: eligible,
    relationships: relationships.filter((relationship) => keys.has(relationship.sourceTable) && keys.has(relationship.targetTable)),
    layers: layers.filter((layer) => layer.visible && layer.tableNames.length > 0 && layer.tableNames.every((key) => keys.has(key))),
  };
}
