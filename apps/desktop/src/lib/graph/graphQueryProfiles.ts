import type { DatabaseType } from "@/types/database";
import type { GraphQueryDatabase, GraphQueryProfile } from "./graphQueryProfile";

// Separate registrations let either dialect ship without enabling the other.
const modules = import.meta.glob<GraphQueryProfile>("./profiles/*QueryProfile.ts", { eager: true, import: "default" });
const profiles = new Map(Object.values(modules).map((profile) => [profile.databaseType, profile]));

export const graphQueryDatabases = [...profiles.keys()];

export function isGraphQueryDatabase(databaseType?: DatabaseType): databaseType is GraphQueryDatabase {
  return !!databaseType && profiles.has(databaseType as GraphQueryDatabase);
}

export function graphQueryProfile(databaseType: GraphQueryDatabase): GraphQueryProfile {
  const profile = profiles.get(databaseType);
  if (!profile) throw new Error(`No graph query profile registered for ${databaseType}`);
  return profile;
}
