import { readFileSync } from "node:fs";
import { describe, expect, it as test } from "vitest";
import { createI18n } from "vue-i18n";
import { translateBackendError, type BackendErrorTranslate } from "@/i18n/backend-errors";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import it from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";

const LOCALES = {
  en,
  es,
  it,
  ja,
  ko,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} as const;

type LocaleKey = keyof typeof LOCALES;

// Reproduces the exact string crates/dbx-core/src/agent_service.rs builds on
// Windows: `\` line continuations strip the newline plus the following indent.
const WINDOWS_JRE_REMOVE_ERROR = [
  "Failed to remove the old JRE directory: C:\\dbx\\jre21",
  "Possible causes:",
  "  - a dbx Agent / java process still holds the directory",
  "  - antivirus software is scanning it",
  "Close any process that may hold the directory, or restart dbx and try again.",
  "(original error: Access is denied. (os error 5))",
].join("\n");

// Every backend message changed away from hardcoded Chinese, paired with the
// key and params it must resolve to.
const CASES: { name: string; message: string; key: string; params?: Record<string, string> }[] = [
  {
    name: "XLSX row limit",
    message: "XLSX supports at most 1,048,575 data rows. Use CSV export for the full result.",
    key: "exportProgress.xlsxRowLimit",
    params: { limit: "1,048,575" },
  },
  {
    name: "streaming export unsupported",
    message: "Streaming export is unsupported for this query. Simplify it or use a supported driver.",
    key: "exportProgress.streamingUnsupported",
  },
  {
    name: "agent session missing",
    message: "Streaming export needs a result-set session, but this driver returned no session_id.",
    key: "exportProgress.agentSessionMissing",
  },
  {
    name: "DuckDB draining",
    message: "The previous DuckDB query is still stopping. Please try again shortly.",
    key: "editor.duckdbDraining",
  },
  {
    name: "JRE directory remove failure (Windows)",
    message: WINDOWS_JRE_REMOVE_ERROR,
    key: "driverStore.jreDirRemoveFailedWindows",
    params: { path: "C:\\dbx\\jre21", error: "Access is denied. (os error 5)" },
  },
  {
    name: "JRE directory remove failure (POSIX)",
    message: "Failed to remove the old JRE directory: /home/u/.dbx/jre21 (original error: Permission denied (os error 13))",
    key: "driverStore.jreDirRemoveFailed",
    params: { path: "/home/u/.dbx/jre21", error: "Permission denied (os error 13)" },
  },
  {
    name: "JRE still in use",
    message: "JRE jre21 is in use by drivers: MySQL, PostgreSQL. Uninstall them first.",
    key: "driverStore.jreInUseByDrivers",
    params: { jre: "jre21", drivers: "MySQL, PostgreSQL" },
  },
  {
    name: "offline package missing registry",
    message: "agent-registry.json not found in the ZIP; not a valid offline driver package.",
    key: "driverStore.offlinePackageRegistryMissing",
  },
  {
    name: "driver update blocked by open connections",
    message: "Close these database connections before updating drivers: Prod MySQL, Stage PG",
    key: "driverStore.driverUpdateBlocked",
    params: { labels: "Prod MySQL, Stage PG" },
  },
  {
    name: "Kafka topic unload unsupported",
    message: "Kafka does not support unloading topics",
    key: "mqClients.unloadTopicUnsupportedKafka",
  },
  {
    name: "file does not exist",
    message: "file does not exist: /tmp/missing.sqlite",
    key: "common.fileNotFound",
    params: { path: "/tmp/missing.sqlite" },
  },
  {
    name: "login rate limited",
    message: "Please try again in 42s",
    key: "auth.rateLimited",
    params: { seconds: "42" },
  },
];

function translatorFor(locale: LocaleKey): BackendErrorTranslate {
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en",
    messages: LOCALES as unknown as Record<string, Record<string, unknown>>,
  });
  return i18n.global.t as unknown as BackendErrorTranslate;
}

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
}

describe("backend error translation", () => {
  test.each(CASES)("$name resolves to a defined English key", ({ key }) => {
    expect(lookup(en as unknown as Record<string, unknown>, key)).toEqual(expect.any(String));
  });

  // zh-CN is the locale that regressed when these messages were switched from
  // hardcoded Chinese to hardcoded English, so it is covered explicitly
  // alongside the other non-English locales.
  const localeKeys = Object.keys(LOCALES) as LocaleKey[];

  describe.each(localeKeys)("in %s", (locale) => {
    const t = translatorFor(locale);

    test.each(CASES)("$name maps to its key and interpolates params", ({ message, key, params }) => {
      const translated = translateBackendError(t, message);

      expect(translated).toBe(params ? t(key, params) : t(key));
      // A missed placeholder would leak `{path}` style tokens to the user.
      expect(translated).not.toMatch(/\{[A-Za-z]+\}/);
      // The raw message must not survive untranslated.
      if (locale !== "en") expect(translated).not.toBe(message);
    });

    test.each(CASES.filter((entry) => entry.params))("$name keeps captured values in the output", ({ message, params }) => {
      const translated = translateBackendError(t, message);
      for (const value of Object.values(params!)) expect(translated).toContain(value);
    });
  });

  test("unknown backend messages are passed through untouched", () => {
    const t = translatorFor("zh-CN");
    expect(translateBackendError(t, "some driver specific failure")).toBe("some driver specific failure");
  });

  test("normalizes Error and structural message objects before translation", () => {
    const t = translatorFor("zh-CN");
    const message = "file does not exist: /tmp/missing.sqlite";
    const expected = t("common.fileNotFound", { path: "/tmp/missing.sqlite" });

    expect(translateBackendError(t, new Error(message))).toBe(expected);
    expect(translateBackendError(t, { message })).toBe(expected);
  });
});

// Matching on message text only works while both sides agree on the wording, so
// pin current backend literals to their Rust source. Compatibility-only patterns
// may remain after the backend stops emitting them.
describe("backend error wording is pinned to the Rust sources", () => {
  const rust = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

  test.each([
    ["crates/dbx-core/src/query_result_export.rs", "XLSX supports at most 1,048,575 data rows. Use CSV export for the full result."],
    ["crates/dbx-core/src/query_result_export.rs", "Streaming export is unsupported for this query. Simplify it or use a supported driver."],
    ["crates/dbx-core/src/query_result_export.rs", "Streaming export needs a result-set session, but this driver returned no session_id."],
    ["crates/dbx-core/src/agent_service.rs", "Failed to remove the old JRE directory: "],
    ["crates/dbx-core/src/agent_service.rs", "is in use by drivers: "],
    ["crates/dbx-core/src/agent_service.rs", "agent-registry.json not found in the ZIP; not a valid offline driver package."],
    ["crates/dbx-core/src/mq/adapters/kafka.rs", "Kafka does not support unloading topics"],
    ["crates/dbx-web/src/auth.rs", "Please try again in {remaining}s"],
    ["crates/dbx-web/src/routes/agents.rs", "Close these database connections before updating drivers: "],
    ["src-tauri/src/commands/agents.rs", "Close these database connections before updating drivers: "],
    ["src-tauri/src/commands/fs_open.rs", "file does not exist: "],
  ])("%s still emits %j", (path, fragment) => {
    expect(rust(path)).toContain(fragment);
  });
});
