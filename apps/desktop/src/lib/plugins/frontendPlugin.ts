import type {
  ConnectionConfig,
  InstalledPlugin,
  PluginCommandContribution,
  PluginConditionClause,
  PluginConditionContextKeys,
  PluginConnectionAction,
  PluginConnectionProviderContribution,
  PluginContribution,
  PluginContributionLocalization,
  PluginContextMenuContribution,
  PluginResultViewContribution,
  PluginFilesystemProviderContribution,
  PluginFormField,
  PluginFormFieldLocalization,
  PluginFormFieldValue,
  PluginManifestLocalization,
  PluginUiContribution,
  PluginWorkbenchContribution,
} from "@/types/database";
import { uuid } from "@/lib/common/utils";
import { clonePluginData } from "./pluginData";

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

  /** Native context-menu entries declared for a specific menu surface. */
  listContextMenuItems(menu: string): PluginContributionEntry<PluginContextMenuContribution>[] {
    return this.listContributions("context-menu").filter((entry) => entry.contribution.menu === menu);
  }

  /** Plugin-rendered query-result views offered from the results toolbar. */
  listResultViews(): PluginContributionEntry<PluginResultViewContribution>[] {
    return this.listContributions("result-view");
  }

  findWorkbench(pluginId: string, contributionId: string): PluginContributionEntry<PluginWorkbenchContribution> | undefined {
    return this.listWorkbenches().find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === contributionId);
  }

  listCommands(): PluginContributionEntry<PluginCommandContribution>[] {
    return this.listContributions("command");
  }

  findCommand(pluginId: string, contributionId: string): PluginContributionEntry<PluginCommandContribution> | undefined {
    return this.listCommands().find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === contributionId);
  }

  /** First command of the plugin whose action opens the given workbench (§4.1). */
  findCommandTargetingWorkbench(pluginId: string, workbenchContributionId: string): PluginCommandContribution | undefined {
    for (const contribution of this.findPlugin(pluginId)?.contributions ?? []) {
      if (contribution.type !== "command") continue;
      const action = contribution.action;
      if (action.type === "open-workbench" && action.workbench === workbenchContributionId) return contribution;
    }
    return undefined;
  }

  /**
   * PR-A4 appToolbar placements (HOST_PLUGIN_UI_SPEC §5.1): one icon entry
   * per visible toolbar placement, ordered by `order` then the full command
   * id so the result never depends on manifest or install order. Toolbar
   * entries stay hidden unless the manifest sets `default_visible: true`
   * (§5.2: toolbar items default to hidden).
   */
  listToolbarMenuCommands(): Array<{ plugin: InstalledPlugin; command: PluginCommandContribution; order: number }> {
    const result: Array<{ plugin: InstalledPlugin; command: PluginCommandContribution; order: number }> = [];
    for (const definition of this.definitions) {
      for (const contribution of definition.contributions) {
        if (contribution.type !== "menus") continue;
        const placements = contribution.items.filter((item) => item.location === "appToolbar" && item.default_visible === true && evaluateWhen(item.when, "appToolbar")).sort((a, b) => a.order - b.order || a.command.localeCompare(b.command));
        for (const item of placements) {
          const command = definition.contributions.find((candidate): candidate is PluginCommandContribution => candidate.type === "command" && candidate.id === item.command);
          if (command) result.push({ plugin: definition.plugin, command, order: item.order });
        }
      }
    }
    return result;
  }

  /**
   * commandPalette placements (HOST_PLUGIN_UI_SPEC §5): palette declarations have no
   * a default_visible gate (§5.2 only mandates hidden-by-default for toolbar items). Commands sort by `order`
   * ascending, then by the fully qualified command id (`${pluginId}.${commandId}`) for a stable order independent of
   * manifest or install order.
   */
  listPaletteMenuCommands(): Array<{ plugin: InstalledPlugin; command: PluginCommandContribution; order: number }> {
    const result: Array<{ plugin: InstalledPlugin; command: PluginCommandContribution; order: number }> = [];
    for (const definition of this.definitions) {
      for (const contribution of definition.contributions) {
        if (contribution.type !== "menus") continue;
        for (const item of contribution.items) {
          if (item.location !== "commandPalette") continue;
          if (!evaluateWhen(item.when, "commandPalette")) continue;
          const command = definition.contributions.find((candidate): candidate is PluginCommandContribution => candidate.type === "command" && candidate.id === item.command);
          if (command) result.push({ plugin: definition.plugin, command, order: item.order });
        }
      }
    }
    return result.sort((left, right) => left.order - right.order || `${left.plugin.manifest.id}.${left.command.id}`.localeCompare(`${right.plugin.manifest.id}.${right.command.id}`));
  }

  /**
   * Resolve any contribution the plugin UI entrypoint can render, whichever host
   * surface opened the tab — a `workbench` opened from the sidebar or a
   * `result-view` opened from the query-result toolbar. Lookups stay scoped to
   * the renderable contribution types, so an id owned by a native context menu
   * or a filesystem provider is not a plugin UI surface.
   */
  findUiContribution(pluginId: string, contributionId: string): PluginContributionEntry<PluginUiContribution> | undefined {
    return [...this.listWorkbenches(), ...this.listResultViews()].find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === contributionId);
  }

  private listContributions<T extends PluginContribution["type"]>(type: T): Array<PluginContributionEntry<Extract<PluginContribution, { type: T }>>> {
    return this.definitions
      .filter((definition) => definition.plugin.compatibility.compatible)
      .flatMap((definition) => definition.contributions.filter((contribution): contribution is Extract<PluginContribution, { type: T }> => contribution.type === type).map((contribution) => ({ plugin: definition.plugin, contribution })))
      .sort((left, right) => `${left.plugin.manifest.name}:${pluginContributionSortLabel(left.contribution)}`.localeCompare(`${right.plugin.manifest.name}:${pluginContributionSortLabel(right.contribution)}`));
  }
}

/** menus contributions carry no label of their own (copy comes from the referenced command); the sort key degrades to the id. */
function pluginContributionSortLabel(contribution: PluginContribution): string {
  return (contribution as { label?: string }).label || contribution.id;
}

/**
 * §5.3/§5.4 condition evaluation (pure): implicit AND within `all`; clauses referencing a missing key evaluate to false for all
 * operators. contextKeys are snapshots provided by the host per scenario.
 */
export function evaluatePluginCommandConditions(clauses: PluginConditionClause[] | undefined, contextKeys: PluginConditionContextKeys): boolean {
  return (clauses ?? []).every((clause) => {
    const actual = contextKeys[clause.key];
    if (actual === undefined) return false;
    if (clause.operator === "equals") return String(actual) === String(clause.value);
    if (clause.operator === "notEquals") return String(actual) !== String(clause.value);
    return Array.isArray(clause.value) && clause.value.map(String).includes(String(actual));
  });
}

/** Placement render gate: when defaults to visible; evaluated against the placement surface snapshot. */
function evaluateWhen(when: { all: PluginConditionClause[] } | undefined, surface: string): boolean {
  return evaluatePluginCommandConditions(when?.all, { surface });
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

/**
 * Well-known provider field key whose declared default seeds the typed
 * `ConnectionConfig.connect_timeout_secs`. A plugin knows its own transport
 * (SSH handshakes on slow links need far more than the generic 10s), so a
 * declared default wins over the global timeout unless the user explicitly
 * picks a per-connection value in the dialog's Advanced tab.
 */
export const PLUGIN_CONNECT_TIMEOUT_FIELD_KEY = "connect_timeout_secs";

export function pluginConnectionConnectTimeoutDefault(contribution: PluginConnectionProviderContribution): number | undefined {
  const field = contribution.fields.find((candidate) => candidate.key === PLUGIN_CONNECT_TIMEOUT_FIELD_KEY && effectiveFieldBinding(candidate) === "config");
  const value = field?.default;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(300, Math.max(1, Math.trunc(value)));
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
  // `null` means "no default" (older hosts serialized the absent case that way),
  // so it must not seed the form with a value the user never typed.
  return Object.fromEntries(contribution.fields.filter((field) => field.default !== undefined && field.default !== null).map((field) => [field.key, field.default])) as Record<string, PluginFormFieldValue>;
}

export function pluginConnectionFormValues(contribution: PluginConnectionProviderContribution, config?: ConnectionConfig): Record<string, PluginFormFieldValue> {
  const values = initialPluginFormValues(contribution);
  if (!config) return values;
  const externalConfig = isRecord(config.external_config) ? config.external_config : {};
  const secrets = config.connection_secrets || {};
  for (const field of contribution.fields) {
    const binding = effectiveFieldBinding(field);
    const secret = secrets[field.key] ?? externalConfig[field.key];
    const value =
      binding === "name" ? config.name : binding === "host" ? config.host : binding === "port" ? config.port : binding === "username" ? config.username : binding === "password" ? config.password : binding === "database" ? config.database : binding === "secret" ? secret : externalConfig[field.key];
    // Port 0 is the stored representation of an optional, automatic port.
    // Keep that input empty on reopen so its protocol-default hint remains visible.
    if (binding === "port" && value === 0 && field.default === undefined) delete values[field.key];
    else if (isPluginFormFieldValue(value)) values[field.key] = value;
  }
  return values;
}

export function buildPluginConnectionConfig(pluginId: string, contribution: PluginConnectionProviderContribution, values: Record<string, PluginFormFieldValue>, existing?: ConnectionConfig): ConnectionConfig {
  const externalConfig: Record<string, unknown> = isRecord(existing?.external_config) ? clonePluginData(existing.external_config) : {};
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
    connect_timeout_secs: existing?.connect_timeout_secs || pluginConnectionConnectTimeoutDefault(contribution) || 10,
    query_timeout_secs: existing?.query_timeout_secs || 60,
    idle_timeout_secs: existing?.idle_timeout_secs || 60,
    keepalive_interval_secs: existing?.keepalive_interval_secs || 30,
    read_only: existing?.read_only || false,
    save_password: existing?.save_password !== false,
    is_production: existing?.is_production || false,
    production_databases: existing?.production_databases || [],
  };
  for (const field of contribution.fields) {
    // A `null` coming from the form (or from a host that hydrated absent
    // defaults as `null`) means "unset": fall back to the declared default and
    // otherwise clear the stored value instead of persisting a null.
    const raw = values[field.key];
    const value = raw === null ? undefined : (raw ?? field.default ?? undefined);
    const binding = effectiveFieldBinding(field);
    if (binding === "config") {
      if (value === undefined) delete externalConfig[field.key];
      else externalConfig[field.key] = value;
    } else if (binding === "secret") {
      // A plugin may migrate a formerly config-bound field to secret binding.
      // Load its legacy value above, then remove the plaintext copy on save.
      delete externalConfig[field.key];
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
  // A config-bound connect_timeout_secs field is the plugin's own handshake
  // timeout (the SSH plugin lets advanced users tune it). Mirror the resolved
  // value into the typed field so the host RPC deadline never fires before the
  // plugin's own timeout. Only applies while the provider declares the field —
  // a stale external_config key from an older manifest must not leak through.
  if (pluginConnectionConnectTimeoutDefault(contribution) !== undefined) {
    const pluginConnectTimeout = externalConfig[PLUGIN_CONNECT_TIMEOUT_FIELD_KEY];
    if (typeof pluginConnectTimeout === "number" && Number.isFinite(pluginConnectTimeout) && pluginConnectTimeout > 0) {
      config.connect_timeout_secs = Math.min(300, Math.max(1, Math.trunc(pluginConnectTimeout)));
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
  // Menus entries carry no display text of their own — labels come from the
  // referenced commands, so they pass through localization untouched.
  if (contribution.type === "menus") return contribution;
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
  } else if (localized.type === "workbench" || localized.type === "command" || localized.type === "result-view") {
    // Workbench, command and result-view contributions all resolve their icon
    // asset path the same way.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
