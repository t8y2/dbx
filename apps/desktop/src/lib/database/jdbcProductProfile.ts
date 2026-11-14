import type { ConnectionConfig, DatabaseType, JdbcMavenBundleInfo } from "@/types/database";
import { jdbcBundleHasArtifacts, type ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";

export type JdbcProductConnectionFields = {
  connectionString: string;
  driverClass: string;
};

export type JdbcProductConnectionFieldsByMode = Record<string, JdbcProductConnectionFields>;

export type JdbcProductModeDefinition = {
  id: string;
  labelKey: string;
  hintKey: string;
  defaultConnectionString: string;
  defaultDriverClass: string;
  managedCoordinates: readonly string[];
};

export type JdbcProductRuntimeDefinition = {
  requiredArtifactNames?: readonly string[];
  id: string;
  modeId: string;
  labelKey: string;
  managedDriverId: string;
  managedCoordinates: readonly string[];
};

export type JdbcProductProfileDefinition = {
  id: string;
  label: string;
  icon: string;
  category: string;
  port: number;
  user: string;
  match: {
    dbType: DatabaseType;
    driverProfile?: string;
  };
  managedDriverId: string;
  runtimeLabelKey: string;
  driverManagerHintPrefixKey: string;
  driverManagerHintSuffixKey: string;
  docsLabelKey: string;
  docsUrl: string;
  missingDriverError: string;
  missingPluginError: string;
  modes: readonly JdbcProductModeDefinition[];
  runtimes?: readonly JdbcProductRuntimeDefinition[];
  isRuntimeDependencyPath?: (path: string, mode: string) => boolean;
  detectMode: (config: Partial<Pick<ConnectionConfig, "connection_string" | "jdbc_driver_class">>) => string;
  isCompatibleRuntimePath: (path: string, mode: string) => boolean;
};

export type JdbcProductRuntimeApi = {
  jdbcPluginStatus: () => Promise<{ installed: boolean; compatible: boolean }>;
  listJdbcMavenBundles: () => Promise<JdbcMavenBundleInfo[]>;
};

export type JdbcProductRuntimeResult = {
  profile: JdbcProductProfileDefinition;
  mode: JdbcProductModeDefinition;
  bundles: JdbcMavenBundleInfo[];
  paths: string[];
  runtimeSelectionId?: string;
};

export type JdbcProductRuntimeErrorKind = "plugin-missing" | "driver-missing";

export class JdbcProductRuntimeError extends Error {
  readonly kind: JdbcProductRuntimeErrorKind;
  readonly profileId: string;
  readonly managedDriverId: string;

  constructor(kind: JdbcProductRuntimeErrorKind, profile: JdbcProductProfileDefinition, managedDriverId = profile.managedDriverId) {
    super(kind === "plugin-missing" ? profile.missingPluginError : profile.missingDriverError);
    this.name = "JdbcProductRuntimeError";
    this.kind = kind;
    this.profileId = profile.id;
    this.managedDriverId = managedDriverId;
  }
}

export type JdbcProductProfileRegistry = {
  profiles: readonly JdbcProductProfileDefinition[];
  byId: ReadonlyMap<string, JdbcProductProfileDefinition>;
};

export function createJdbcProductProfileRegistry(profiles: readonly JdbcProductProfileDefinition[]): JdbcProductProfileRegistry {
  const byId = new Map<string, JdbcProductProfileDefinition>();
  const matcherKeys = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id.trim()) throw new Error("JDBC product profile id must not be empty");
    if (byId.has(profile.id)) throw new Error(`Duplicate JDBC product profile id: ${profile.id}`);
    const matcherKey = `${profile.match.dbType}:${profile.match.driverProfile ?? "*"}`;
    if (matcherKeys.has(matcherKey)) throw new Error(`Duplicate JDBC product profile matcher: ${matcherKey}`);
    if (profile.modes.length === 0) throw new Error(`JDBC product profile must define at least one mode: ${profile.id}`);
    byId.set(profile.id, profile);
    matcherKeys.add(matcherKey);
  }
  return { profiles: [...profiles], byId };
}

export function jdbcProductProfileMatches(profile: JdbcProductProfileDefinition, config: Pick<ConnectionConfig, "db_type" | "driver_profile">): boolean {
  return config.db_type === profile.match.dbType && (profile.match.driverProfile === undefined || config.driver_profile === profile.match.driverProfile);
}

export function jdbcProductMode(profile: JdbcProductProfileDefinition, modeId: string): JdbcProductModeDefinition {
  const mode = profile.modes.find((candidate) => candidate.id === modeId) ?? profile.modes[0];
  if (!mode) throw new Error(`JDBC product profile has no modes: ${profile.id}`);
  return mode;
}

export function jdbcProductConnectionDefaults(profile: JdbcProductProfileDefinition, modeId: string): JdbcProductConnectionFields {
  const mode = jdbcProductMode(profile, modeId);
  return {
    connectionString: mode.defaultConnectionString,
    driverClass: mode.defaultDriverClass,
  };
}

export function createJdbcProductConnectionFieldsByMode(profile: JdbcProductProfileDefinition, config?: Partial<Pick<ConnectionConfig, "connection_string" | "jdbc_driver_class">>): JdbcProductConnectionFieldsByMode {
  const fields = Object.fromEntries(profile.modes.map((mode) => [mode.id, jdbcProductConnectionDefaults(profile, mode.id)]));
  if (!config) return fields;

  const modeId = profile.detectMode(config);
  const defaults = jdbcProductConnectionDefaults(profile, modeId);
  fields[modeId] = {
    connectionString: config.connection_string?.trim() || defaults.connectionString,
    driverClass: config.jdbc_driver_class?.trim() || defaults.driverClass,
  };
  return fields;
}

export function rememberJdbcProductConnectionFields(profile: JdbcProductProfileDefinition, fields: JdbcProductConnectionFieldsByMode, modeId: string, current: Partial<JdbcProductConnectionFields>): JdbcProductConnectionFieldsByMode {
  const defaults = jdbcProductConnectionDefaults(profile, modeId);
  return {
    ...fields,
    [modeId]: {
      connectionString: current.connectionString?.trim() || defaults.connectionString,
      driverClass: current.driverClass?.trim() || defaults.driverClass,
    },
  };
}

export function isJdbcProductDefaultDriverClass(profile: JdbcProductProfileDefinition, value: string | undefined): boolean {
  const normalized = value?.trim() || "";
  return !normalized || profile.modes.some((mode) => mode.defaultDriverClass === normalized);
}

export function jdbcProductManagedCoordinates(profile: JdbcProductProfileDefinition): string[] {
  return Array.from(new Set([...profile.modes.flatMap((mode) => [...mode.managedCoordinates]), ...(profile.runtimes ?? []).flatMap((runtime) => [...runtime.managedCoordinates])]));
}

export function validateJdbcProductManagedDriver(profile: JdbcProductProfileDefinition, driver: ManagedJdbcDriverDefinition | undefined, runtime?: JdbcProductRuntimeDefinition): void {
  const managedDriverId = runtime?.managedDriverId ?? profile.managedDriverId;
  if (!driver || driver.id !== managedDriverId) {
    throw new Error(`JDBC product profile ${profile.id} references unknown managed driver: ${managedDriverId}`);
  }
  const ownedCoordinates = new Set(driver.bundles.map(({ coordinate }) => coordinate));
  const coordinates = runtime?.managedCoordinates ?? profile.modes.flatMap((mode) => [...mode.managedCoordinates]);
  const unownedCoordinate = coordinates.find((coordinate) => !ownedCoordinates.has(coordinate));
  if (unownedCoordinate) {
    throw new Error(`JDBC product profile ${profile.id} requires coordinate not owned by ${driver.id}: ${unownedCoordinate}`);
  }
}

export function isJdbcProductManagedMavenCoordinate(profile: JdbcProductProfileDefinition, coordinate: string): boolean {
  return jdbcProductManagedCoordinates(profile).includes(coordinate);
}

export function jdbcProductManagedRuntimePaths(profile: JdbcProductProfileDefinition, bundles: readonly JdbcMavenBundleInfo[], modeId: string, runtimeId = ""): string[] {
  const bundleByCoordinate = new Map(bundles.map((bundle) => [bundle.coordinate, bundle]));
  const runtime = jdbcProductRuntimeOptions(profile, modeId).find((candidate) => candidate.id === runtimeId);
  if (!runtime) return [];
  const requiredBundles = runtime.managedCoordinates.map((coordinate) => bundleByCoordinate.get(coordinate));
  if (requiredBundles.some((bundle) => !jdbcBundleHasArtifacts(bundle, runtime.requiredArtifactNames))) return [];
  return requiredBundles.flatMap((bundle) => (bundle?.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean));
}

export function jdbcProductRuntimeSelectionId(profile: JdbcProductProfileDefinition, modeId: string, runtimeId = ""): string {
  return `${profile.id}:${modeId}${runtimeId ? `:${runtimeId}` : ""}`;
}

export function jdbcProductRuntimeOptions(profile: JdbcProductProfileDefinition, modeId: string): JdbcProductRuntimeDefinition[] {
  const mode = jdbcProductMode(profile, modeId);
  return [{ id: "", modeId: mode.id, labelKey: profile.runtimeLabelKey, managedDriverId: profile.managedDriverId, managedCoordinates: mode.managedCoordinates }, ...(profile.runtimes ?? []).filter((runtime) => runtime.modeId === mode.id)];
}

export function jdbcProductConfiguredRuntime(profile: JdbcProductProfileDefinition, modeId: string, paths: readonly string[]): JdbcProductRuntimeDefinition {
  const runtimes = jdbcProductRuntimeOptions(profile, modeId);
  return runtimes.find((runtime) => runtime.id && paths.some((path) => runtime.managedCoordinates.some((coordinate) => path.replaceAll("\\", "/").split("/").includes(mavenBundleId(coordinate))))) ?? runtimes[0]!;
}

// Only an explicit picker action replaces selected runtime JARs. Config/resource
// paths survive; existing manual classpaths are never silently migrated.
export function selectJdbcProductRuntimePaths(profile: JdbcProductProfileDefinition, modeId: string, configuredPaths: readonly string[], runtimePaths: readonly string[]): string[] {
  const resources = configuredPaths.filter((path) => !isJdbcProductManagedMavenPath(profile, path) && !profile.modes.some((mode) => profile.isCompatibleRuntimePath(path, mode.id)) && !profile.isRuntimeDependencyPath?.(path, modeId));
  return Array.from(new Set([...resources, ...runtimePaths]));
}

function mavenBundleId(coordinate: string): string {
  return coordinate
    .trim()
    .split("")
    .map((character) => (/^[A-Za-z0-9.-]$/.test(character) ? character : "_"))
    .join("");
}

export function isJdbcProductManagedMavenPath(profile: JdbcProductProfileDefinition, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return jdbcProductManagedCoordinates(profile).some((coordinate) => normalized.split("/").includes(mavenBundleId(coordinate)));
}

export function isJdbcProductRuntimeInstallError(profile: JdbcProductProfileDefinition, message: string): boolean {
  return message.includes(profile.missingDriverError) || message.includes(profile.missingPluginError);
}

export async function ensureJdbcProductRuntimeDrivers(profile: JdbcProductProfileDefinition, config: ConnectionConfig, api: JdbcProductRuntimeApi): Promise<JdbcProductRuntimeResult | undefined> {
  if (!jdbcProductProfileMatches(profile, config)) return undefined;

  const modeId = profile.detectMode(config);
  const mode = jdbcProductMode(profile, modeId);
  const defaults = jdbcProductConnectionDefaults(profile, modeId);
  config.connection_string = config.connection_string?.trim() || defaults.connectionString;
  config.jdbc_driver_class = config.jdbc_driver_class?.trim() || defaults.driverClass;
  const configuredPaths = (config.jdbc_driver_paths ?? []).map((path) => path.trim()).filter(Boolean);
  const runtime = jdbcProductConfiguredRuntime(profile, modeId, configuredPaths);

  const pluginStatus = await api.jdbcPluginStatus();
  if (!pluginStatus.installed || !pluginStatus.compatible) {
    throw new JdbcProductRuntimeError("plugin-missing", profile, runtime.managedDriverId);
  }

  const bundles = await api.listJdbcMavenBundles();
  const managedCoordinates = jdbcProductManagedCoordinates(profile);
  const managedBundles = bundles.filter((bundle) => managedCoordinates.includes(bundle.coordinate));
  const managedPaths = new Set(managedBundles.flatMap((bundle) => bundle.artifacts.map((artifact) => artifact.path).filter(Boolean)));
  const hasCustomRuntime = configuredPaths.some((path) => profile.isCompatibleRuntimePath(path, modeId) && !managedPaths.has(path) && !isJdbcProductManagedMavenPath(profile, path));
  if (hasCustomRuntime) {
    config.jdbc_driver_paths = configuredPaths;
    return { profile, mode, bundles, paths: configuredPaths };
  }

  const installedCoordinates = new Set(bundles.map((bundle) => bundle.coordinate));
  if (runtime.managedCoordinates.some((coordinate) => !installedCoordinates.has(coordinate))) {
    throw new JdbcProductRuntimeError("driver-missing", profile, runtime.managedDriverId);
  }

  const customPaths = configuredPaths.filter((path) => !managedPaths.has(path) && !isJdbcProductManagedMavenPath(profile, path));
  const runtimePaths = jdbcProductManagedRuntimePaths(profile, bundles, modeId, runtime.id);
  if (runtimePaths.length === 0) {
    throw new JdbcProductRuntimeError("driver-missing", profile, runtime.managedDriverId);
  }

  const paths = Array.from(new Set([...customPaths, ...runtimePaths]));
  config.jdbc_driver_paths = paths;
  return {
    profile,
    mode,
    bundles,
    paths,
    runtimeSelectionId: jdbcProductRuntimeSelectionId(profile, modeId, runtime.id),
  };
}
