import { PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DRIVER_PROFILE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE } from "@/lib/database/phoenixConnection";
import type { ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";

export const PHOENIX_JDBC_DRIVER_VERSION = "5.2.1 / 6.0.0";

export const PHOENIX_MANAGED_MAVEN_COORDINATES = [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE] as const;
export const PHOENIX_MANAGED_JDBC_DRIVER: ManagedJdbcDriverDefinition = {
  id: PHOENIX_DRIVER_PROFILE,
  label: "Apache Phoenix JDBC",
  version: PHOENIX_JDBC_DRIVER_VERSION,
  jre: "21",
  bundles: PHOENIX_MANAGED_MAVEN_COORDINATES.map((coordinate) => ({
    coordinate,
    repositories: ["https://repo.maven.apache.org/maven2/"],
  })),
};
