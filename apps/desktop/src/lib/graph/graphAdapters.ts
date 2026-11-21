import type { DatabaseType, QueryResult } from "@/types/database";
import { graphPropertyMatchesValue, type GraphEdge, type GraphNode, type GraphProperty } from "./graphResult";
import { applyGraphPropertyToResult, buildNebulaGraphExpand, buildNebulaGraphPropertyUpdate, graphPropertyMatchesValue as nebulaPropertyMatchesValue } from "./nebulaGraph";
import { applyNeo4jGraphPropertyToResult, buildNeo4jGraphExpand, buildNeo4jGraphPropertyUpdate } from "./neo4jGraph";

interface GraphAdapter {
  buildPropertyUpdate: (entity: GraphNode | GraphEdge, property: GraphProperty, value: string | boolean) => string;
  buildExpand: (node: GraphNode) => string;
  applyPropertyUpdate: (result: QueryResult, entity: GraphNode | GraphEdge, property: GraphProperty, updated: GraphProperty) => void;
  matchesPropertyValue: (property: GraphProperty, value: string | boolean) => boolean;
}

const adapters: Partial<Record<DatabaseType, GraphAdapter>> = {
  nebula: { buildPropertyUpdate: buildNebulaGraphPropertyUpdate, buildExpand: buildNebulaGraphExpand, applyPropertyUpdate: applyGraphPropertyToResult, matchesPropertyValue: nebulaPropertyMatchesValue },
  neo4j: { buildPropertyUpdate: buildNeo4jGraphPropertyUpdate, buildExpand: buildNeo4jGraphExpand, applyPropertyUpdate: applyNeo4jGraphPropertyToResult, matchesPropertyValue: graphPropertyMatchesValue },
};

export function graphAdapterForDatabase(type: DatabaseType | undefined): GraphAdapter | undefined {
  return type ? adapters[type] : undefined;
}
