import { describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

// Non-English locales export `withEnglishFallback({ ... })`, which deep-merges
// English underneath at import time, so an imported locale always "has" every
// English key and a dropped translation is invisible. Swap the merge for the
// identity to read what each locale file itself declares; the runtime check
// below re-applies the real merge.
vi.mock("../locales/fallback", () => ({ withEnglishFallback: (messages: Record<string, unknown>) => messages }));

type Messages = Record<string, unknown>;
type Locale = "az" | "en" | "es" | "it" | "ja" | "ko" | "pt-BR" | "ru" | "tr" | "zh-CN" | "zh-TW";

const declared: Record<Locale, Messages> = { az, en, es, it: itLocale, ja, ko, "pt-BR": ptBR, ru, tr, "zh-CN": zhCN, "zh-TW": zhTW };
const ALL_LOCALES = Object.keys(declared) as Locale[];
const EXCEPT_AZ_TR = ALL_LOCALES.filter((locale) => locale !== "az" && locale !== "tr");

interface FeatureMessages {
  feature: string;
  /** `a.b.key`, `a.b.*` (whole namespace, no extra keys) or `a.b.prefix*`, resolved against English. */
  keys: string[];
  /** Locales whose own file must declare every key; the others may fall back to English. */
  locales?: Locale[];
  /** The declared text must also differ from English. */
  translated?: boolean;
}

const under = (namespace: string, keys: string[]) => keys.map((key) => `${namespace}.${key}`);

// Message sets that render in every UI language: a key missing from `en`
// leaks the raw key path, and a key missing from a locale silently shows
// English.
const FEATURE_MESSAGES: FeatureMessages[] = [
  { feature: "AI HTML preview (#6467)", keys: under("ai", ["htmlPreviewLabel", "htmlExpandPreview", "htmlExpandPreviewHint", "htmlSaveSafe", "htmlSaveFailed", "htmlCopySource", "htmlCopyRiskBody", "htmlCopyRiskAccept", "htmlCopyRiskRemember", "htmlCopyRiskToast"]) },
  { feature: "AI conversation export (#6467)", keys: under("ai", ["exportConversation", "conversationExportMarkdown", "conversationExportHtml", "conversationRoleUser", "conversationRoleAssistant", "conversationFailedMarker", "conversationExportEmpty"]) },
  { feature: "AI conversation management", keys: under("ai", ["renameConversation", "conversationRenameFailed", "clearDatabaseSelection", "searchDatabases", "noDatabasesFound"]) },
  { feature: "AI auto routing (#9118)", keys: ["ai.actions.auto", "ai.routing.recognizing", "ai.routing.chip", "ai.routing.switchTo", "ai.defaultAutoRouting", "ai.defaultAutoRoutingDescription"] },
  { feature: "plugin AI conversation", keys: ["ai.pluginHttpModelOnly", "ai.pluginWelcome", "ai.pluginFollowUp"] },
  { feature: "quick open", keys: ["quickOpen.*", "settings.shortcutGlobalSearch"] },
  {
    feature: "editor tab context menu",
    keys: under("contextMenu", ["changeOrientation", "closeAllTabs", "closeLeftTabs", "closeOtherTabs", "closeRightTabs", "closeTab", "closeTabGroup", "compactTabTitle", "copyName", "editTabGroup", "fullTabTitle", "pinTab", "resetTabGroup", "splitDown", "splitRight", "unpinTab", "unsplit"]),
  },
  { feature: "offline Agent export", keys: ["driverStore.offlineExport*"] },
  { feature: "offline Agent import", keys: ["driverStore.offlineImport*", "driverStore.offlineJreImport*"] },
  { feature: "multi-database execution and export progress", keys: ["multiDbExecute.*", "exportProgress.*"], locales: ["en", "zh-CN"] },
  { feature: "process list batch terminate", keys: under("processList", ["batchTerminate", "batchTerminateTitle", "batchTerminateConfirm", "batchTerminateRunning", "batchTerminateSummary"]) },
  { feature: "cached result fallback", keys: ["grid.cachedResultUnavailable", "grid.reexecuteQuery"] },
  { feature: "Nacos global replace", keys: ["nacos.contentReplace*", "nacos.replaceHistory.*"], locales: EXCEPT_AZ_TR, translated: true },
  { feature: "SQLite table rebuild notice", keys: ["structureEditor.sqliteRebuildNotice"] },
  { feature: "custom types", keys: ["customType.kinds.composite", "customType.tabs.properties", "customType.members.empty", "customType.properties.empty", "customType.ddl.empty", "customType.ddl.incomplete", "contextMenu.viewDetails"], translated: true },
  { feature: "Dameng object compilation", keys: ["contextMenu.compileObjectFailedTitle", "contextMenu.compileObjectFailedMessage"], locales: EXCEPT_AZ_TR, translated: true },
  { feature: "user administration Host change", keys: ["userAdmin.changeHost", "userAdmin.newHost"], translated: true },
  { feature: "plugin batch actions", keys: ["pluginPlatform.batchDuplicateSources", "pluginPlatform.batchRefreshFailed"], locales: EXCEPT_AZ_TR },
  { feature: "shared refresh action (#8768)", keys: ["common.refresh"] },
  { feature: "transfer bulk select", keys: under("transfer", ["bulkSelectObjects", "bulkSelectTitle", "bulkSelectHint", "bulkSelectPlaceholder", "bulkSelectConfirm", "bulkSelectMatched", "bulkSelectUnmatched", "noMatchingObjects"]), translated: true },
  { feature: "table info pin", keys: ["grid.pinTableInfo", "grid.unpinTableInfo"], translated: true },
  { feature: "Consul workspace", keys: ["consul.ui.*", "consul.tools.*"] },
  { feature: "MQTT max packet size", keys: ["connection.mqttMaxPacketSize"] },
  { feature: "sidebar search skip hint", keys: ["sidebar.searchConnectionSkipped"] },
  { feature: "PostgreSQL legacy TLS", keys: ["connection.postgresLegacyTls", "connection.postgresLegacyTlsHint"] },
  { feature: "settings search sections", keys: ["settings.syncWebDavWebDescription", "settings.performanceSection"] },
  { feature: "Redis batch expiration", keys: under("redis", ["batchExpiry", "batchExpiryTitle", "batchExpirySelected", "batchExpiryApply", "batchExpirySuccess", "batchExpiryPartial"]) },
];

function lookup(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Messages)[key] : undefined), messages);
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Messages).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function resolveKeys(selector: string): string[] {
  if (!selector.endsWith("*")) return [selector];
  const dot = selector.lastIndexOf(".");
  const parent = selector.slice(0, dot);
  const stem = selector.slice(dot + 1, -1);
  const keys = leafPaths(lookup(en, parent))
    .filter((path) => path.startsWith(stem))
    .map((path) => `${parent}.${path}`);
  expect(keys.length, `${selector} matches no English messages`).toBeGreaterThan(0);
  return keys;
}

/** Named interpolations such as `{count}`; literal interpolations like `{'{'}` are text. */
function placeholders(message: unknown): string[] {
  if (typeof message !== "string") return [];
  return [...new Set([...message.matchAll(/\{\s*([A-Za-z_][\w]*)\s*\}/g)].map((match) => match[1]))].sort();
}

describe.each(FEATURE_MESSAGES)("$feature messages", ({ keys: selectors, locales = ALL_LOCALES, translated }) => {
  const keys = selectors.flatMap(resolveKeys);

  it.each(ALL_LOCALES)("%s declares its messages with the English placeholders", (locale) => {
    for (const key of keys) {
      const text = lookup(declared[locale], key);
      const english = lookup(en, key);
      if (text === undefined && !locales.includes(locale)) continue;
      expect(text, `${locale}: ${key}`).toBeTypeOf("string");
      expect((text as string).trim(), `${locale}: ${key}`).not.toBe("");
      expect(placeholders(text), `${locale}: ${key} placeholders`).toEqual(placeholders(english));
      if (translated && locale !== "en") expect(text, `${locale}: ${key} must not reuse the English text`).not.toBe(english);
    }
    for (const selector of selectors.filter((entry) => entry.endsWith(".*"))) {
      const namespace = selector.slice(0, -2);
      const extra = leafPaths(lookup(declared[locale], namespace)).filter((path) => !keys.includes(`${namespace}.${path}`));
      expect(extra, `${locale}: keys under ${namespace} that English does not declare`).toEqual([]);
    }
  });
});

describe("feature message rendering", () => {
  const keys = FEATURE_MESSAGES.flatMap((entry) => entry.keys.flatMap(resolveKeys));

  it.each(ALL_LOCALES)("%s renders every feature message through vue-i18n with its parameters", async (locale) => {
    const { withEnglishFallback } = await vi.importActual<typeof import("../locales/fallback")>("../locales/fallback");
    const messages = locale === "en" ? en : withEnglishFallback(declared[locale]);
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages }, missingWarn: false, fallbackWarn: false });
    for (const key of keys) {
      const params = Object.fromEntries(placeholders(lookup(messages, key)).map((name) => [name, `<${name}>`]));
      const text = i18n.global.t(key, params);
      expect(text, `${locale}: ${key}`).not.toBe(key);
      for (const value of Object.values(params)) expect(text, `${locale}: ${key}`).toContain(value);
    }
    i18n.dispose();
  });
});

describe("feature message content rules", () => {
  it.each(EXCEPT_AZ_TR)("%s keeps the Dameng validity labels as the database literals", (locale) => {
    const objects = (locale === "en" ? en : declared[locale]).objects as Messages | undefined;
    expect(objects?.validStatus ?? en.objects.validStatus).toBe("VALID");
    expect(objects?.invalidStatus ?? en.objects.invalidStatus).toBe("INVALID");
  });

  it.each(ALL_LOCALES)("%s warns that a SQLite rebuild forces CAST conversion with lossy 0.0 values", (locale) => {
    const notice = String(lookup(declared[locale], "structureEditor.sqliteRebuildNotice"));
    expect(notice).toContain("CAST");
    expect(notice).toContain("0.0");
  });
});
