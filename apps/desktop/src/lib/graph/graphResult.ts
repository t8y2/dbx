import type { QueryResult } from "@/types/database";

export interface GraphVid {
  type: string;
  value: string;
}

export interface GraphProperty {
  owner: string;
  name: string;
  type: string;
  value: string | boolean | null;
}

export interface GraphNode {
  id: string;
  vid?: GraphVid;
  labels: string[];
  properties: GraphProperty[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceVid?: GraphVid;
  targetVid?: GraphVid;
  type: string;
  rank?: string;
  properties: GraphProperty[];
}

export interface GraphCellRef {
  row: number;
  column: number;
  kind: string;
  nodeIds: string[];
  edgeIds: string[];
  displayParts?: GraphDisplayPart[];
}

export type GraphDisplayPart = string | { nodeId: string } | { edgeId: string; path?: boolean };

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cells: GraphCellRef[];
}

interface GraphCellEnvelope {
  __dbx_graph_cell: "nebula-v1";
  kind: string;
  display: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  displayParts?: GraphDisplayPart[];
}

function graphCellEnvelope(value: unknown): value is GraphCellEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cell = value as Partial<GraphCellEnvelope>;
  return cell.__dbx_graph_cell === "nebula-v1" && typeof cell.display === "string" && typeof cell.kind === "string" && Array.isArray(cell.nodes) && Array.isArray(cell.edges);
}

function mergeProperties(left: GraphProperty[], right: GraphProperty[]): GraphProperty[] {
  const values = new Map(left.map((property) => [`${property.owner}\u0000${property.name}`, property]));
  for (const property of right) values.set(`${property.owner}\u0000${property.name}`, property);
  return [...values.values()];
}

function mergeNode(left: GraphNode | undefined, right: GraphNode): GraphNode {
  if (!left) return right;
  return {
    ...left,
    ...right,
    vid: right.vid ?? left.vid,
    labels: [...new Set([...left.labels, ...right.labels])],
    properties: mergeProperties(left.properties, right.properties),
  };
}

function mergeEdge(left: GraphEdge | undefined, right: GraphEdge): GraphEdge {
  if (!left) return right;
  return { ...left, ...right, sourceVid: right.sourceVid ?? left.sourceVid, targetVid: right.targetVid ?? left.targetVid, rank: right.rank ?? left.rank, properties: mergeProperties(left.properties, right.properties) };
}

export function mergeGraphResults(left: GraphResult | undefined, right: GraphResult | undefined, rowOffset = 0): GraphResult | undefined {
  if (!left && !right) return undefined;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const cells = [...(left?.cells ?? [])];
  for (const node of [...(left?.nodes ?? []), ...(right?.nodes ?? [])]) {
    nodes.set(node.id, mergeNode(nodes.get(node.id), node));
  }
  for (const edge of [...(left?.edges ?? []), ...(right?.edges ?? [])]) edges.set(edge.id, mergeEdge(edges.get(edge.id), edge));
  for (const cell of right?.cells ?? []) cells.push({ ...cell, row: cell.row + rowOffset });
  return { nodes: [...nodes.values()], edges: [...edges.values()], cells };
}

export function graphResultRows(graph: GraphResult | undefined, count: number): GraphResult | undefined {
  if (!graph) return undefined;
  const cells = graph.cells.filter((cell) => cell.row < count);
  const nodeIds = new Set(cells.flatMap((cell) => cell.nodeIds));
  const edgeIds = new Set(cells.flatMap((cell) => cell.edgeIds));
  const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return { nodes: graph.nodes.filter((node) => nodeIds.has(node.id)), edges, cells };
}

export function extractGraphCells(result: QueryResult): QueryResult {
  let rows: QueryResult["rows"] | undefined;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const cells: GraphCellRef[] = [];
  result.rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (!graphCellEnvelope(value)) return;
      rows ??= result.rows.map((original) => [...original]);
      rows[rowIndex][columnIndex] = value.display;
      for (const node of value.nodes) {
        nodes.set(node.id, mergeNode(nodes.get(node.id), node));
      }
      for (const edge of value.edges) edges.set(edge.id, mergeEdge(edges.get(edge.id), edge));
      cells.push({ row: rowIndex, column: columnIndex, kind: value.kind, nodeIds: [...new Set(value.nodes.map((node) => node.id))], edgeIds: [...new Set(value.edges.map((edge) => edge.id))], ...(value.displayParts ? { displayParts: value.displayParts } : {}) });
    });
  });
  if (rows) result.rows = rows;
  if (cells.length) result.graph_data = mergeGraphResults(result.graph_data, { nodes: [...nodes.values()], edges: [...edges.values()], cells });
  return result;
}

export function updateGraphResultProperty(result: QueryResult, entity: GraphNode | GraphEdge, property: GraphProperty, updated: GraphProperty, formatNode: (node: GraphNode) => string, formatEdge: (edge: GraphEdge) => string, formatCell?: (cell: GraphCellRef) => string | undefined): void {
  const graph = result.graph_data;
  if (!graph) return;
  const nodes = graph.nodes.filter((node) => node.id === entity.id);
  const edges = graph.edges.filter((edge) => edge.id === entity.id);
  for (const item of [...nodes, ...edges]) {
    const target = item.properties.find((candidate) => candidate.owner === property.owner && candidate.name === property.name);
    if (target) target.value = updated.value;
  }
  const affected = graph.cells.filter((cell) => cell.nodeIds.includes(entity.id) || cell.edgeIds.includes(entity.id));
  if (!affected.length) return;
  const rows = result.rows.map((row) => [...row]);
  for (const cell of affected) {
    const node = cell.kind === "vertex" ? nodes.find((candidate) => cell.nodeIds[0] === candidate.id) : undefined;
    const edge = cell.kind === "edge" ? edges.find((candidate) => cell.edgeIds[0] === candidate.id) : undefined;
    if (rows[cell.row]) rows[cell.row][cell.column] = formatCell?.(cell) ?? (node ? formatNode(node) : edge ? formatEdge(edge) : rows[cell.row][cell.column]);
  }
  result.rows = rows;
}
