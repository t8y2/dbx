import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import en from "../../apps/desktop/src/i18n/locales/en.ts";
import es from "../../apps/desktop/src/i18n/locales/es.ts";
import it from "../../apps/desktop/src/i18n/locales/it.ts";
import ja from "../../apps/desktop/src/i18n/locales/ja.ts";
import ko from "../../apps/desktop/src/i18n/locales/ko.ts";
import ptBR from "../../apps/desktop/src/i18n/locales/pt-BR.ts";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN.ts";
import zhTW from "../../apps/desktop/src/i18n/locales/zh-TW.ts";

const messagesViewPath = "apps/desktop/src/components/layout/QueryMessagesView.vue";
const viewSwitcherPath = "apps/desktop/src/components/layout/QueryResultViewSwitcher.vue";
const contentAreaPath = "apps/desktop/src/components/layout/ContentArea.vue";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("QueryMessagesView SFC compiles", () => {
  const { descriptor, errors } = parse(source(messagesViewPath), { filename: messagesViewPath });
  assert.deepEqual(errors, [], `${messagesViewPath} should parse without SFC errors`);
  assert.ok(descriptor.scriptSetup, `${messagesViewPath} should have a script setup block`);
  compileScript(descriptor, { id: messagesViewPath });
  assert.ok(descriptor.template);
  const result = compileTemplate({ id: messagesViewPath, filename: messagesViewPath, source: descriptor.template!.content });
  assert.deepEqual(result.errors, [], `${messagesViewPath} template should compile`);
});

test("QueryMessagesView maps severities to badge tones", () => {
  const view = source(messagesViewPath);

  // error/fatal/panic are errors, anything containing "warn" is a warning,
  // everything else (NOTICE, INFO, Note, ...) stays muted.
  assert.match(view, /normalized === "error" \|\| normalized === "fatal" \|\| normalized === "panic"\) return "error"/);
  assert.match(view, /normalized\.includes\("warn"\)\) return "warning"/);
  assert.match(view, /return "muted"/);
  for (const tone of ["muted", "warning", "error"] as const) {
    assert.match(view, new RegExp(`${tone}: "`));
  }
});

test("QueryMessagesView renders message text, extras, and the empty state", () => {
  const view = source(messagesViewPath);

  assert.match(view, /t\("queryMessages\.empty"\)/);
  assert.match(view, /\{\{ message\.severity \}\}/);
  assert.match(view, /\{\{ message\.message \}\}/);
  assert.match(view, /v-if="message\.detail"/);
  assert.match(view, /v-if="message\.hint"/);
  assert.match(view, /v-if="message\.code"[\s\S]*t\("queryMessages\.code", \{ code: message\.code \}\)/);
});

test("view switcher exposes a messages button with a count badge", () => {
  const switcher = source(viewSwitcherPath);

  assert.match(switcher, /canShowMessages: boolean/);
  assert.match(switcher, /messageCount\?: number/);
  assert.match(switcher, /<MessageSquareText class="block h-3\.5 w-3\.5 self-center" \/>/);
  assert.match(switcher, /:disabled="!canShowMessages"/);
  assert.match(switcher, /@click="selectView\('messages'\)"/);
  assert.match(switcher, /v-if="!compact && messageCount > 0"[\s\S]*?\{\{ messageCount \}\}/);
  // The tooltip/aria label carries the count when messages exist.
  assert.match(switcher, /messagesTooltip = computed\(\(\) => \(props\.messageCount > 0/);
});

test("ContentArea wires server messages into the switcher and the messages view", () => {
  const contentArea = source(contentAreaPath);

  assert.match(contentArea, /resultMessageCount = computed\(\(\) => props\.activeTab\.result\?\.messages\?\.length \?\? 0\)/);
  assert.match(contentArea, /canShowMessagesOutput = computed\(\(\) => resultMessageCount\.value > 0\)/);
  assert.equal((contentArea.match(/:can-show-messages="canShowMessagesOutput"/g) ?? []).length, 2);
  assert.equal((contentArea.match(/:message-count="resultMessageCount"/g) ?? []).length, 2);
  assert.match(contentArea, /<QueryMessagesView v-else-if="activeOutputView === 'messages'"[\s\S]*:messages="activeTab\.result\?\.messages \?\? \[\]"/);
  // Results with no result set auto-switch via the shared default-view helper.
  assert.match(contentArea, /import \{ defaultViewForResult \} from "@\/lib\/query\/queryResultDefaultView"/);
  assert.match(contentArea, /emit\("update:activeOutputView", result \? defaultViewForResult\(result\) : "summary"\)/);
});

test("every locale defines the query message strings", () => {
  const locales = { en, es, it, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW };

  for (const [name, locale] of Object.entries(locales)) {
    assert.ok(locale.queryMessages.empty.length > 0, `${name}: queryMessages.empty`);
    assert.ok(locale.queryMessages.code.includes("{code}"), `${name}: queryMessages.code keeps the {code} placeholder`);
    assert.ok(locale.tabs.messages.length > 0, `${name}: tabs.messages`);
  }
});
