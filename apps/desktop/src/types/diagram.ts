import type { CustomDiagramRelationship, DiagramPosition, DiagramTable, DiagramRelationship } from "@/lib/diagram/erDiagram";

export interface InferredRelationship {
  id: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  confidence: "high" | "medium";
  strategy: "naming_convention" | "type_signature" | "regex";
}

export interface MatchResult {
  relationships: InferredRelationship[];
  conflicts: InferredRelationship[];
  pending: InferredRelationship[];
  stats: { total: number; high: number; medium: number };
}

export interface LayoutOptions {
  direction?: "LR" | "TB" | "RL" | "BT";
}

export interface HistorySnapshot {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  positions: Record<string, DiagramPosition>;
  layers: DiagramLayer[];
  tables: DiagramTable[];
  customRelationships: CustomDiagramRelationship[];
  edgeWaypoints: Record<string, { x: number; y: number }[]>;
  edgeHandleHints: Record<string, { sourceHandle?: string; targetHandle?: string }>;
  matchConfirms: string[];
  matchIgnores: string[];
}

export interface DiagramNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { table: DiagramTable };
  selected?: boolean;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  /** Absolute canvas waypoints from ELK / obstacle router (includes endpoints). */
  waypoints?: { x: number; y: number }[];
  data: { relationship: DiagramRelationship | InferredRelationship };
}

export type RelationshipKind = "foreign-key" | "custom" | "inferred";

export interface MatchRule {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  priority: number;
}

export interface MatchStorageKeys {
  confirms: string;
  ignores: string;
  rules: string;
  enabled: string;
}

export type LayerLayoutMode = "free" | "auto";

export interface DiagramLayer {
  id: string;
  name: string;
  color: string;
  tableNames: string[];
  collapsed: boolean;
  visible: boolean;
  /** free = locked (keep relative table positions); auto = unlocked (auto-layout rearranges tables in this layer) */
  layoutMode: LayerLayoutMode;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
}

export const LAYER_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];

/** Canvas selection driving the diagram inspector panel */
export type InspectorTarget = { kind: "table"; tableName: string } | { kind: "edge"; edgeId: string } | null;
