import assert from "node:assert/strict";
import { test } from "vitest";
import type { ComposerTranslation } from "vue-i18n";
import { translateBackendError } from "../../apps/desktop/src/i18n/backend-errors";
import en from "../../apps/desktop/src/i18n/locales/en";
import es from "../../apps/desktop/src/i18n/locales/es";
import it from "../../apps/desktop/src/i18n/locales/it";
import ja from "../../apps/desktop/src/i18n/locales/ja";
import ptBR from "../../apps/desktop/src/i18n/locales/pt-BR";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN";
import zhTW from "../../apps/desktop/src/i18n/locales/zh-TW";

const errorCodes = ["claudeCodeNotInstalled", "claudeCodeCliPathInvalid", "claudeCodeEnvInvalid", "claudeCodeEnvReserved", "claudeCodeNotAuthenticated", "claudeCodeMcpConfigInvalid", "dbxMcpMissing", "claudeCodeMcpStartupFailed", "claudeCodeCommandLineTooLong", "claudeCodeRunFailed"] as const;

test("Claude Code CLI errors are localized while retaining their stable code and raw diagnostics", () => {
  const messages: Record<string, string> = {
    "ai.cliErrors.claudeCodeMcpConfigInvalid": "Claude MCP config could not be parsed.",
    "ai.cliErrors.code": "Error code: {code}",
    "ai.cliErrors.reportHint": "Include this information in the report.",
    "ai.cliErrors.details": "Diagnostic details:",
  };
  const t = ((key: string, params?: Record<string, string>) => {
    let value = messages[key] ?? key;
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, replacement);
    return value;
  }) as ComposerTranslation;
  const raw = "Invalid MCP configuration: MCP config file not found: C:\\Temp\\mcp.json";

  const translated = translateBackendError(t, `[claudeCodeMcpConfigInvalid] ${raw}`);

  assert.match(translated, /Claude MCP config could not be parsed/);
  assert.match(translated, /Error code: claudeCodeMcpConfigInvalid/);
  assert.match(translated, /Include this information in the report/);
  assert.match(translated, /Diagnostic details:/);
  assert.match(translated, /C:\\Temp\\mcp\.json/);
});

test("every current locale defines all Claude Code CLI diagnostic messages", () => {
  const locales = { en, es, it, ja, ptBR, zhCN, zhTW } as const;

  for (const [localeName, locale] of Object.entries(locales)) {
    assert.equal(typeof locale.ai.requestFailed, "string", `${localeName}.ai.requestFailed`);
    assert.equal(typeof locale.ai.cliErrors.code, "string", `${localeName}.ai.cliErrors.code`);
    assert.equal(typeof locale.ai.cliErrors.details, "string", `${localeName}.ai.cliErrors.details`);
    assert.equal(typeof locale.ai.cliErrors.reportHint, "string", `${localeName}.ai.cliErrors.reportHint`);
    for (const code of errorCodes) {
      assert.equal(typeof locale.ai.cliErrors[code], "string", `${localeName}.ai.cliErrors.${code}`);
      assert.ok(locale.ai.cliErrors[code].trim().length > 0, `${localeName}.ai.cliErrors.${code} should not be empty`);
    }
  }
});
