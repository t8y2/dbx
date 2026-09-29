import { describe, expect, it } from "vitest";
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

// English is the source of truth for message parameters: every `t(key, params)`
// call site passes the placeholder names declared by `en`, so a locale that
// introduces an interpolation placeholder English does not declare renders the
// raw `{name}` text to the user (Korea's `grid.jumpToPage` shipped as
// "{page}페이지로 이동" because the aria-label is called without arguments).
//
// Importing `../locales/<name>` yields `withEnglishFallback({...})`, i.e. the
// locale merged on top of `en`. Keys whose merged value equals the English value
// come from the fallback and are skipped, so only locale-declared values are
// inspected here.
const locales: Array<[string, Record<string, unknown>]> = [
  ["az", az as Record<string, unknown>],
  ["es", es as Record<string, unknown>],
  ["it", itLocale as Record<string, unknown>],
  ["ja", ja as Record<string, unknown>],
  ["ko", ko as Record<string, unknown>],
  ["pt-BR", ptBR as Record<string, unknown>],
  ["ru", ru as Record<string, unknown>],
  ["tr", tr as Record<string, unknown>],
  ["zh-CN", zhCN as Record<string, unknown>],
  ["zh-TW", zhTW as Record<string, unknown>],
];

function flattenMessages(value: unknown, prefix = "", acc = new Map<string, string>()): Map<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    acc.set(prefix, String(value));
    return acc;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenMessages(child, prefix ? `${prefix}.${key}` : key, acc);
  }
  return acc;
}

/**
 * Collects vue-i18n named interpolation placeholders (`{name}`) from a message.
 * Literal-brace escapes (`{'text'}` / `{'{'}`) are skipped: they render their
 * content verbatim, so they are not parameters.
 */
function interpolationPlaceholders(message: string): Set<string> {
  const found = new Set<string>();
  let index = 0;
  while (index < message.length) {
    if (message[index] !== "{") {
      index += 1;
      continue;
    }
    if (message.startsWith("{'", index)) {
      const literalEnd = message.indexOf("'}", index + 2);
      if (literalEnd === -1) break;
      index = literalEnd + 2;
      continue;
    }
    const end = message.indexOf("}", index + 1);
    if (end === -1) break;
    const inner = message.slice(index + 1, end);
    if (inner && !inner.startsWith("'")) found.add(inner);
    index = end + 1;
  }
  return found;
}

const englishMessages = flattenMessages(en as Record<string, unknown>);

describe("locale interpolation placeholder parity", () => {
  it.each(locales)("%s declares no placeholder English does not", (_name, messages) => {
    const offenders: string[] = [];
    for (const [key, value] of flattenMessages(messages)) {
      const english = englishMessages.get(key);
      if (english === undefined || value === english) continue;
      const allowed = interpolationPlaceholders(english);
      const extra = [...interpolationPlaceholders(value)].filter((placeholder) => !allowed.has(placeholder));
      if (extra.length > 0) offenders.push(`${key}: {${extra.join("}, {")}} in "${value}"`);
    }
    expect(offenders).toEqual([]);
  });
});
