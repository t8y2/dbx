import type {
  ConnectionConfig,
  InstalledPlugin,
  PluginConnectionAction,
  PluginConnectionProviderContribution,
  PluginContribution,
  PluginContributionLocalization,
  PluginFilesystemProviderContribution,
  PluginFormField,
  PluginFormFieldLocalization,
  PluginFormFieldValue,
  PluginManifestLocalization,
  PluginWorkbenchContribution,
} from "@/types/database";
import { uuid } from "@/lib/common/utils";

const PLUGIN_CONNECTION_PROVIDER_OPTION_PREFIX = "plugin-provider:";

export interface FrontendPluginDefinition {
  plugin: InstalledPlugin;
  contributions: PluginContribution[];
  diagnostics: string[];
}

export interface PluginContributionEntry<T extends PluginContribution> {
  plugin: InstalledPlugin;
  contribution: T;
}

export class FrontendPluginRegistry {
  private readonly definitions: FrontendPluginDefinition[];

  constructor(plugins: readonly InstalledPlugin[] = [], locale = "en") {
    this.definitions = plugins.map((plugin) => normalizeFrontendPlugin(plugin, locale));
  }

  listPlugins(): FrontendPluginDefinition[] {
    return [...this.definitions];
  }

  findPlugin(pluginId: string): FrontendPluginDefinition | undefined {
    return this.definitions.find((definition) => definition.plugin.manifest.id === pluginId);
  }

  listConnectionProviders(): PluginContributionEntry<PluginConnectionProviderContribution>[] {
    return this.listContributions("connection-provider");
  }

  listWorkbenches(): PluginContributionEntry<PluginWorkbenchContribution>[] {
    return this.listContributions("workbench");
  }

  listFilesystemProviders(): PluginContributionEntry<PluginFilesystemProviderContribution>[] {
    return this.listContributions("filesystem-provider");
  }

  findWorkbench(pluginId: string, contributionId: string): PluginContributionEntry<PluginWorkbenchContribution> | undefined {
    return this.listWorkbenches().find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === contributionId);
  }

  private listContributions<T extends PluginContribution["type"]>(type: T): Array<PluginContributionEntry<Extract<PluginContribution, { type: T }>>> {
    return this.definitions
      .filter((definition) => definition.plugin.compatibility.compatible)
      .flatMap((definition) => definition.contributions.filter((contribution): contribution is Extract<PluginContribution, { type: T }> => contribution.type === type).map((contribution) => ({ plugin: definition.plugin, contribution })))
      .sort((left, right) => `${left.plugin.manifest.name}:${left.contribution.label || left.contribution.id}`.localeCompare(`${right.plugin.manifest.name}:${right.contribution.label || right.contribution.id}`));
  }
}

export function createFrontendPluginRegistry(plugins: readonly InstalledPlugin[], locale = "en"): FrontendPluginRegistry {
  return new FrontendPluginRegistry(plugins, locale);
}

export function pluginConnectionProviderOptionValue(pluginId: string, providerId: string): string {
  return `${PLUGIN_CONNECTION_PROVIDER_OPTION_PREFIX}${encodeURIComponent(pluginId)}/${encodeURIComponent(providerId)}`;
}

export function parsePluginConnectionProviderOptionValue(value: string): { pluginId: string; providerId: string } | null {
  if (!value.startsWith(PLUGIN_CONNECTION_PROVIDER_OPTION_PREFIX)) return null;
  const encoded = value.slice(PLUGIN_CONNECTION_PROVIDER_OPTION_PREFIX.length);
  const separator = encoded.indexOf("/");
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const pluginId = decodeURIComponent(encoded.slice(0, separator));
    const providerId = decodeURIComponent(encoded.slice(separator + 1));
    return pluginId && providerId ? { pluginId, providerId } : null;
  } catch {
    return null;
  }
}

export function pluginConnectionProviderIcon(entry: PluginContributionEntry<PluginConnectionProviderContribution>): string | undefined {
  return entry.contribution.icon || entry.plugin.manifest.icon;
}

export function pluginConnectionActionsForDialog(contribution: PluginConnectionProviderContribution, editing: boolean): PluginConnectionAction[] {
  const actions: PluginConnectionAction[] = [
    ...(contribution.actions || []).map((action) => ({ ...action, kind: "custom" as const })),
    ...((contribution.capabilities || []).includes("test") ? [{ id: "test", kind: "test" as const, variant: "outline" as const }] : []),
    editing ? ({ id: "save", kind: "save", variant: "default", close_on_success: true } satisfies PluginConnectionAction) : ({ id: "save-and-connect", kind: "save-and-connect", variant: "default", close_on_success: true } satisfies PluginConnectionAction),
  ];
  return actions.filter((action) => action.when === undefined || action.when === "always" || (action.when === "edit" ? editing : !editing));
}

export function initialPluginFormValues(contribution: PluginConnectionProviderContribution): Record<string, PluginFormFieldValue> {
  return Object.fromEntries(contribution.fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])) as Record<string, PluginFormFieldValue>;
}

export function pluginConnectionFormValues(contribution: PluginConnectionProviderContribution, config?: ConnectionConfig): Record<string, PluginFormFieldValue> {
  const values = initialPluginFormValues(contribution);
  if (!config) return values;
  const externalConfig = isRecord(config.external_config) ? config.external_config : {};
  const secrets = config.connection_secrets || {};
  for (const field of contribution.fields) {
    const binding = effectiveFieldBinding(field);
    const value =
      binding === "name"
        ? config.name
        : binding === "host"
          ? config.host
          : binding === "port"
            ? config.port
            : binding === "username"
              ? config.username
              : binding === "password"
                ? config.password
                : binding === "database"
                  ? config.database
                  : binding === "secret"
                    ? secrets[field.key]
                    : externalConfig[field.key];
    if (isPluginFormFieldValue(value)) values[field.key] = value;
  }
  return values;
}

export function buildPluginConnectionConfig(pluginId: string, contribution: PluginConnectionProviderContribution, values: Record<string, PluginFormFieldValue>, existing?: ConnectionConfig): ConnectionConfig {
  const externalConfig: Record<string, unknown> = isRecord(existing?.external_config) ? structuredClone(existing.external_config) : {};
  const connectionSecrets = { ...existing?.connection_secrets };
  const config: ConnectionConfig = {
    id: existing?.id || uuid(),
    name: existing?.name || contribution.label,
    note: existing?.note,
    db_type: "plugin",
    driver_profile: existing?.driver_profile || "plugin",
    driver_label: contribution.label,
    host: existing?.host || "",
    port: existing?.port || 0,
    username: existing?.username || "",
    password: existing?.password || "",
    database: existing?.database,
    external_config: externalConfig,
    plugin_id: pluginId,
    plugin_connection_provider: contribution.id,
    plugin_connection_type: contribution.database_type,
    connection_secrets: connectionSecrets,
    transport_layers: existing?.transport_layers || [],
    connect_timeout_secs: existing?.connect_timeout_secs || 10,
    query_timeout_secs: existing?.query_timeout_secs || 60,
    idle_timeout_secs: existing?.idle_timeout_secs || 60,
    keepalive_interval_secs: existing?.keepalive_interval_secs || 30,
    read_only: existing?.read_only || false,
    is_production: existing?.is_production || false,
    production_databases: existing?.production_databases || [],
  };
  for (const field of contribution.fields) {
    const value = values[field.key] ?? field.default;
    const binding = effectiveFieldBinding(field);
    if (binding === "config") {
      if (value === undefined) delete externalConfig[field.key];
      else externalConfig[field.key] = value;
    } else if (binding === "secret") {
      if (value === undefined || value === "") delete connectionSecrets[field.key];
      else connectionSecrets[field.key] = String(value);
    } else if (binding === "name") {
      config.name = String(value || contribution.label);
    } else if (binding === "host") {
      config.host = String(value || "");
    } else if (binding === "port") {
      config.port = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(65535, Math.trunc(value))) : 0;
    } else if (binding === "username") {
      config.username = String(value || "");
    } else if (binding === "password") {
      config.password = String(value || "");
    } else if (binding === "database") {
      config.database = value === undefined || value === "" ? undefined : String(value);
    }
  }
  return config;
}

function effectiveFieldBinding(field: PluginFormField): NonNullable<PluginFormField["binding"]> {
  return field.binding || (field.type === "password" ? "secret" : "config");
}

function normalizeFrontendPlugin(plugin: InstalledPlugin, locale: string): FrontendPluginDefinition {
  const localization = pluginLocalization(plugin, locale);
  const localizedPlugin = localizePluginMetadata(plugin, localization);
  const contributions = (localizedPlugin.manifest.contributions || []).map((contribution) => localizeContribution(contribution, localization?.contributions?.[contribution.id], localizedPlugin.manifest.name));
  const diagnostics: string[] = [];
  if (!plugin.compatibility.compatible) diagnostics.push(...(plugin.compatibility.errors || []));
  return { plugin: localizedPlugin, contributions, diagnostics };
}

function pluginLocalization(plugin: InstalledPlugin, locale: string): PluginManifestLocalization | undefined {
  const localizations = plugin.manifest.localizations;
  if (!localizations || !locale) return undefined;
  const normalizedLocale = locale.replace("_", "-").toLowerCase();
  const exact = Object.entries(localizations).find(([key]) => key.replace("_", "-").toLowerCase() === normalizedLocale)?.[1];
  if (exact) return exact;
  const language = normalizedLocale.split("-")[0];
  return Object.entries(localizations).find(([key]) => key.replace("_", "-").toLowerCase() === language)?.[1];
}

function localizePluginMetadata(plugin: InstalledPlugin, localization?: PluginManifestLocalization): InstalledPlugin {
  return {
    ...plugin,
    manifest: {
      ...plugin.manifest,
      name: localizedRequiredText(plugin.manifest.name, localization?.name),
      icon: optionalPluginAssetPath(plugin.manifest.icon),
      description: localizedOptionalText(plugin.manifest.description, localization?.description),
    },
  };
}

function localizeContribution(contribution: PluginContribution, localization: PluginContributionLocalization | undefined, pluginName: string): PluginContribution {
  const fallbackLabel = contribution.type === "connection-provider" ? optionalTrimmed(contribution.label) || optionalTrimmed(pluginName) || contribution.id : contribution.label;
  const localized = {
    ...contribution,
    label: localizedRequiredText(fallbackLabel, localization?.label),
    description: localizedOptionalText(contribution.description, localization?.description),
  } as PluginContribution;
  if (localized.type === "connection-provider") {
    localized.icon = optionalPluginAssetPath(localized.icon);
    localized.fields = localized.fields.map((field) => localizeField(field, localization?.fields?.[field.key]));
    localized.actions = localized.actions?.map((action) => ({
      ...action,
      label: localizedRequiredText(action.label, localization?.actions?.[action.id]?.label),
      description: localizedOptionalText(action.description, localization?.actions?.[action.id]?.description),
    }));
  } else if (localized.type === "workbench") {
    localized.icon = optionalPluginAssetPath(localized.icon);
  }
  return localized;
}

function localizeField(field: PluginFormField, localization?: PluginFormFieldLocalization): PluginFormField {
  if (!localization) return field;
  return {
    ...field,
    label: localizedRequiredText(field.label, localization.label),
    description: localizedOptionalText(field.description, localization.description),
    placeholder: localizedOptionalText(field.placeholder, localization.placeholder),
    options: field.options?.map((option) => ({ ...option, label: localizedRequiredText(option.label, localization.options?.[option.value]) })),
  };
}

function localizedRequiredText(fallback: string, localized: unknown): string {
  return nonEmptyString(localized) ? localized.trim() : fallback;
}

function localizedOptionalText(fallback: string | undefined, localized: unknown): string | undefined {
  return typeof localized === "string" ? localized.trim() : fallback;
}

function optionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalPluginAssetPath(value: unknown): string | undefined {
  const path = optionalTrimmed(value);
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("\\")) return undefined;
  const parts = path.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? undefined : path;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPluginFormFieldValue(value: unknown): value is PluginFormFieldValue {
  return value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
