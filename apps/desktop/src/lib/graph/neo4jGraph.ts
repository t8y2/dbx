import { updateGraphResultProperty, type GraphEdge, type GraphNode, type GraphProperty, type GraphVid } from "./graphResult";
import type { QueryResult } from "@/types/database";

function quoteIdentifier(value: string): string {
  if (!value || [...value].some((char) => (char.codePointAt(0) ?? 0) < 32)) throw new Error("Invalid Neo4j identifier");
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "``")}\``;
}

function integer(value: string | boolean): string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(value)) throw new Error("Invalid Neo4j integer");
  const number = BigInt(value);
  if (number < -9223372036854775808n || number > 9223372036854775807n) throw new Error("Neo4j integer is outside the signed 64-bit range");
  return value;
}

function identity(variable: string, vid: GraphVid | undefined): string {
  if (vid?.type === "neo4j-id") return `id(${variable}) = ${integer(vid.value)}`;
  if (vid?.type === "neo4j-element-id" && vid.value) return `elementId(${variable}) = ${JSON.stringify(vid.value)}`;
  throw new Error("Missing Neo4j entity identity");
}

function propertyValue(type: string, value: string | boolean | null): string {
  if (type === "string" && typeof value === "string") return JSON.stringify(value);
  if (type === "bool" && typeof value === "boolean") return value ? "true" : "false";
  if (type === "int" && value !== null) return integer(value);
  if (type === "float" && typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) && Number.isFinite(Number(value))) return `toFloat(${JSON.stringify(value)})`;
  throw new Error("Invalid value for this Neo4j property type");
}

export function buildNeo4jGraphPropertyUpdate(entity: GraphNode | GraphEdge, property: GraphProperty, value: string | boolean): string {
  if (property.owner) throw new Error("Neo4j properties do not have a Tag owner");
  const node = "labels" in entity;
  const variable = node ? "n" : "r";
  const pattern = node ? `(n${entity.labels.map((label) => `:${quoteIdentifier(label)}`).join("")})` : `(s)-[r:${quoteIdentifier(entity.type)}]->(t)`;
  const predicates = [identity(variable, entity.vid)];
  if (!node) predicates.push(identity("s", entity.sourceVid), identity("t", entity.targetVid));
  const target = `${variable}.${quoteIdentifier(property.name)}`;
  // The dependent SET acquires the write lock before checking the saved value.
  return `MATCH ${pattern} WHERE ${predicates.join(" AND ")} SET ${target} = ${target} WITH ${variable} WHERE ${target} = ${propertyValue(property.type, property.value)} SET ${target} = ${propertyValue(property.type, value)} RETURN ${target} AS dbx_value`;
}

export function buildNeo4jGraphExpand(node: GraphNode): string {
  return `MATCH (n) WHERE ${identity("n", node.vid)} OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 200`;
}

function propertiesJSON(properties: GraphProperty[]): string {
  const values = [...properties]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((property) => {
      const value = property.value;
      let literal = JSON.stringify(value);
      if (typeof value === "string" && ["int", "float", "List", "Map"].includes(property.type)) {
        try {
          const parsed: unknown = JSON.parse(value);
          if ((["int", "float"].includes(property.type) && typeof parsed === "number" && Number.isFinite(parsed)) || (property.type === "List" && Array.isArray(parsed)) || (property.type === "Map" && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))) literal = value;
        } catch {
          // Older Agents may label raw byte text as List; quote it as text.
        }
      }
      return `${JSON.stringify(property.name)}:${literal}`;
    });
  return `{${values.join(",")}}`;
}

export function applyNeo4jGraphPropertyToResult(result: QueryResult, entity: GraphNode | GraphEdge, property: GraphProperty, updated: GraphProperty): void {
  const nodes = new Map(result.graph_data?.nodes.map((node) => [node.id, node]));
  const edges = new Map(result.graph_data?.edges.map((edge) => [edge.id, edge]));
  const propertiesDisplay = (properties: GraphProperty[]) => (properties.length ? ` ${propertiesJSON(properties)}` : "");
  updateGraphResultProperty(
    result,
    entity,
    property,
    updated,
    (node) => `(${node.labels.length ? `:${node.labels.join(":")}` : ""}${propertiesDisplay(node.properties)})`,
    (edge) => `[:${edge.type}${propertiesDisplay(edge.properties)}]`,
    (cell) => {
      if (!cell.displayParts) return undefined;
      const parts: string[] = [];
      for (const part of cell.displayParts) {
        if (typeof part === "string") parts.push(part);
        else if ("nodeId" in part) {
          const node = nodes.get(part.nodeId);
          if (!node?.vid) return undefined;
          parts.push(`{"elementId":${JSON.stringify(node.vid.value)},"labels":${JSON.stringify(node.labels)},"properties":${propertiesJSON(node.properties)}}`);
        } else {
          const edge = edges.get(part.edgeId);
          if (!edge?.vid || !edge.sourceVid || !edge.targetVid) return undefined;
          parts.push(`{"elementId":${JSON.stringify(edge.vid.value)},"endElementId":${JSON.stringify(edge.targetVid.value)},"properties":${propertiesJSON(edge.properties)},"startElementId":${JSON.stringify(edge.sourceVid.value)},"type":${JSON.stringify(edge.type)}}`);
        }
      }
      return parts.join("");
    },
  );
  if (!("labels" in entity) || !result.neo4j_node_cells?.length) return;
  const affected = new Set(result.graph_data?.cells.filter((cell) => cell.kind === "vertex" && cell.nodeIds.includes(entity.id)).map((cell) => `${cell.row}:${cell.column}`));
  result.neo4j_node_cells = result.neo4j_node_cells.map((cell) =>
    affected.has(`${cell.row_index}:${cell.column_index}`) ? { ...cell, properties: cell.properties.map((candidate) => (candidate.name === property.name ? { ...candidate, value: updated.value === null ? null : String(updated.value) } : candidate)) } : cell,
  );
}
