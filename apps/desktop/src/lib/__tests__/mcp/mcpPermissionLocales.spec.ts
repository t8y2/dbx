import { describe, expect, it, vi } from "vitest";
import i18nSource from "@/i18n/index.ts?raw";

// Check each locale's own messages so English fallback cannot hide missing translations.
vi.mock("@/i18n/locales/fallback", () => ({ withEnglishFallback: (messages: Record<string, unknown>) => messages }));

const supportedLocales = [...i18nSource.match(/const supportedLocales: Locale\[\] = \[([^\]]+)\]/)![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const locales = import.meta.glob<{ default: { settings: Record<string, unknown>; history: { detail: Record<string, unknown> } } }>("../../../i18n/locales/*.ts");
const keys = [
  "mcpDatabaseConfigure",
  "mcpDatabaseApply",
  "mcpDatabaseSaveHint",
  "mcpDatabaseSavedInherited",
  "mcpDatabaseSelectResults",
  "mcpDatabaseBatchLevel",
  "mcpDatabaseBatchHighRiskConfirm",
  "mcpDatabaseShowMore",
  "mcpDatabaseRemoveConfirm",
  "mcpExecutionModeDescription",
  "mcpPermissionsDraftHint",
  "mcpCallSafety",
  "mcpCallSafetyLegacy",
  "mcpCallSafetyEnabled",
  "mcpCallSafetyDisabled",
  "mcpCallSafetyLegacyHint",
  "mcpCallSafetyMigrate",
  "mcpCallSafetyDisableLegacy",
  "mcpCallSafetyConfirm",
  "mcpCallSafetyHint",
  "mcpCallSafetyDesktopHint",
  "mcpToolApprovalGenericTitle",
  "mcpCapabilityTitle",
  "mcpCapabilityDescription",
  "mcpCapabilityConnectionCreate",
  "mcpCapabilityConnectionRemove",
  "mcpAccessTreeDescription",
  "mcpAccessTreeExceptionsOnly",
  "mcpToolsetDetailTools",
  "mcpToolsetDetailCoverage",
  "mcpToolsetDetailClose",
];

function mcpMessages(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return /^(settings\.mcp|history\.detail\.mcp|pluginPlatform\.(mcpTools|externalMcp))/.test(prefix) ? { [prefix]: value } : {};
  if (!value || typeof value !== "object") return {};
  return Object.assign({}, ...Object.entries(value).map(([key, child]) => mcpMessages(child, prefix ? `${prefix}.${key}` : key)));
}

const placeholders = (message: string) => [...message.matchAll(/\{([\w]+)\}/g)].map((match) => match[1]).sort();
// New capability/access-control messages must be translated explicitly. Older
// installation and SQL-approval labels still use the supported English fallback.
const requiresOwnTranslation = (key: string) =>
  /^(settings\.mcp(?:AccessLevel|AccessTree|Database(?:Configure|Apply|SaveHint|SavedInherited|SelectResults|Batch|ShowMore|RemoveConfirm)|Browser|Capabilities|Confirmation|Coverage|ManagementCapabilities$|OpenCallHistory$|PermissionsDraftHint$|Plugin|Tool(?:Approval|Consul|Detail|Nacos|SkippedConnections)|Toolset)|history\.detail\.mcp(?:Client|Transport|Access|Confirmation)$|pluginPlatform\.(?:mcpTools|externalMcp))/.test(
    key,
  );

describe("MCP permission text", () => {
  it.each(supportedLocales)("translates new MCP labels and preserves all interpolation parameters in %s", async (locale) => {
    const english = mcpMessages((await locales["../../../i18n/locales/en.ts"]()).default);
    const messages = (await locales[`../../../i18n/locales/${locale}.ts`]()).default;
    const own = mcpMessages(messages);
    expect(Object.keys(own).filter(requiresOwnTranslation).sort(), locale).toEqual(Object.keys(english).filter(requiresOwnTranslation).sort());
    const { withEnglishFallback } = await vi.importActual<typeof import("@/i18n/locales/fallback")>("@/i18n/locales/fallback");
    const translated = mcpMessages(withEnglishFallback(messages));
    expect(Object.keys(translated).sort(), locale).toEqual(Object.keys(english).sort());
    for (const [key, message] of Object.entries(english)) {
      // Legacy sentence fragments may intentionally be empty (e.g. Korean
      // puts the entire listener hint after its interpolated host).
      expect(translated[key], `${locale}.${key}`).toEqual(requiresOwnTranslation(key) ? expect.stringMatching(/\S/) : expect.any(String));
      expect(placeholders(translated[key]), `${locale}.${key}`).toEqual(placeholders(message));
    }
    if (locale !== "en") {
      for (const key of [
        "settings.mcpToolNacosSearchConfigs",
        "settings.mcpToolNacosRollbackConfig",
        "settings.mcpToolNacosGetService",
        "settings.mcpToolNacosRegisterInstance",
        "settings.mcpToolNacosDeregisterInstance",
        "settings.mcpAccessTreeLegacyHint",
        "settings.mcpPluginAuthorizeDescription",
      ]) {
        expect(own[key], `${locale}.${key} must not be an English placeholder`).not.toBe(english[key]);
      }
    }
  });

  it.each(supportedLocales)("provides permission explanations and removes retired presets in %s", async (locale) => {
    const {
      default: { settings, history },
    } = await locales[`../../../i18n/locales/${locale}.ts`]();
    for (const key of keys) expect(settings[key], `${locale}.${key}`).toEqual(expect.stringMatching(/\S/));
    for (const key of ["mcpTransport", "mcpAccess", "mcpConfirmation"]) expect(history.detail[key], `${locale}.history.detail.${key}`).toEqual(expect.stringMatching(/\S/));
    expect((settings.mcpBrowser as Record<string, unknown>).pluginImmediate, `${locale}.mcpBrowser.pluginImmediate`).toEqual(expect.stringMatching(/\S/));
    expect(settings).not.toHaveProperty("mcpPreset");
    expect(settings).not.toHaveProperty("mcpPresetTitle");
    expect(settings).not.toHaveProperty("mcpAuthStepCapabilitiesTitle");
    expect(settings).not.toHaveProperty("mcpAuthStepCapabilitiesDescription");
  });
});
