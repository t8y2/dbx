import type { GraphQueryDatabase } from "./graphQueryProfile";
import { graphQueryProfile } from "./graphQueryProfiles";
export type { GraphFunctionDefinition } from "./graphQueryProfile";

export function graphFunctionDefinitions(databaseType: GraphQueryDatabase) {
  return graphQueryProfile(databaseType).functions;
}

export function graphFunctionDefinition(name: string, databaseType: GraphQueryDatabase) {
  return graphFunctionDefinitions(databaseType).find((definition) => definition.name.toLowerCase() === name.toLowerCase());
}
