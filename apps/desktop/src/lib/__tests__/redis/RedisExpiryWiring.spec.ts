import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../../../components/redis/RedisKeyBrowser.vue", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../../../components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
const localeSources = {
  en: readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8"),
  es: readFileSync(new URL("../../../i18n/locales/es.ts", import.meta.url), "utf8"),
  it: readFileSync(new URL("../../../i18n/locales/it.ts", import.meta.url), "utf8"),
  ja: readFileSync(new URL("../../../i18n/locales/ja.ts", import.meta.url), "utf8"),
  "pt-BR": readFileSync(new URL("../../../i18n/locales/pt-BR.ts", import.meta.url), "utf8"),
  "zh-CN": readFileSync(new URL("../../../i18n/locales/zh-CN.ts", import.meta.url), "utf8"),
  "zh-TW": readFileSync(new URL("../../../i18n/locales/zh-TW.ts", import.meta.url), "utf8"),
};

function findFunction(source: string, name: string): ts.FunctionDeclaration {
  const parsed = parse(source, { filename: `${name}.vue` });
  expect(parsed.errors).toEqual([]);
  const script = parsed.descriptor.scriptSetup;
  expect(script).toBeDefined();
  const program = ts.createSourceFile(`${name}.ts`, script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = program.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(declaration).toBeDefined();
  return declaration!;
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function callName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return `${call.expression.expression.getText()}.${call.expression.name.text}`;
  return undefined;
}

describe("Redis expiry mode wiring", () => {
  it("writes every create type before applying exactly one shared expiration policy", () => {
    const create = findFunction(browserSource, "createRedisKey");
    const calls = callsIn(create);
    const expectedWriterArgumentCounts: Record<string, number> = {
      "api.redisSetString": 4,
      "api.redisJsonSet": 4,
      "api.redisHashSet": 5,
      "api.redisListPush": 4,
      "api.redisSetAdd": 4,
      "api.redisZadd": 5,
      "api.redisStreamAdd": 5,
    };

    for (const [name, argumentCount] of Object.entries(expectedWriterArgumentCounts)) {
      const writerCalls = calls.filter((call) => callName(call) === name);
      expect(writerCalls.length, `${name} should be used by the create flow`).toBeGreaterThan(0);
      expect(
        writerCalls.every((call) => call.arguments.length === argumentCount),
        `${name} must not receive a per-write TTL`,
      ).toBe(true);
    }

    expect(calls.map(callName)).toContain("applyRedisExpiryPolicy");
    expect(create.getText()).toContain("if (creatingKey.value) return;");
    expect(calls.map(callName)).not.toContain("api.redisSetTtl");
    expect(calls.map(callName)).not.toContain("api.redisSetExpireAt");
    expect(create.getText().lastIndexOf("applyRedisExpiryPolicy")).toBeGreaterThan(create.getText().lastIndexOf("api.redisStreamAdd"));
    expect(findFunction(browserSource, "syncWrittenKey").getText()).toContain('if (created.redis_type === "none")');
    expect(create.getText()).toContain('toast(t("redis.keyExpiredBeforeDisplay"), 3000)');
    expect(create.getText()).toContain("if (wroteValue && writtenKeyRaw)");
    expect(findFunction(browserSource, "reflectWrittenKey").getText()).toContain("removeKnownKey(keyRaw)");
  });

  it("keeps only unwritten structured entries after a later writer fails", () => {
    const create = findFunction(browserSource, "createRedisKey").getText();
    const partialRecoveryStart = create.indexOf("if (writingStructuredEntries)");
    const genericRecoveryStart = create.lastIndexOf("if (wroteValue && writtenKeyRaw)");
    const partialRecovery = create.slice(partialRecoveryStart, genericRecoveryStart);

    expect(create).toContain("let writingStructuredEntries = false;");
    expect(create).toContain("const pendingEntries = createKeyEntries.value.slice();");
    expect(create.match(/for \(const entry of pendingEntries\)/g)).toHaveLength(4);
    expect(create.match(/removeWrittenCreateKeyEntry\(entry\.id\)/g)).toHaveLength(4);
    expect(create).toContain("createKeyPartiallyWritten.value = true;");
    expect(partialRecovery).toContain("await reflectWrittenKey(writtenKeyRaw);");
    expect(partialRecovery).toContain('t("redis.createKeyPartialWrite")');
    expect(partialRecovery).not.toContain("showCreateKeyDialog.value = false;");
    expect(browserSource).toContain(':disabled="creatingKey || createKeyPartiallyWritten"');
    expect(findFunction(browserSource, "onCreateKeyDialogOpenChange").getText()).toContain("if (!open && creatingKey.value) return;");
    expect(findFunction(browserSource, "onCreateKeyTypeChange").getText()).toContain("if (creatingKey.value || createKeyPartiallyWritten.value) return;");
  });

  it("defaults TTL editing by server state, supports absolute prefill, and keeps teleported controls inside the editor", () => {
    const start = findFunction(viewerSource, "startEditTtl").getText();
    const save = findFunction(viewerSource, "saveTtl").getText();
    const currentTtl = findFunction(viewerSource, "currentEditableTtl").getText();

    expect(start).toContain("redisExpiryModeForTtl(ttl)");
    expect(currentTtl).toContain("computeTtlForExpiryEdit(countdownTtl.value, data.value.ttl)");
    expect(viewerSource).toContain("unixSecondsToCalendarDateTime(Math.ceil(Date.now() / 1_000) + ttl)");
    expect(save).toContain("validateRedisExpiry");
    expect(save).toContain("applyRedisExpiryPolicy");
    expect(save).toContain("toast(errorMessage(error), 3000)");
    expect(viewerSource).toContain('"[data-date-time-picker-content]"');
    expect(viewerSource).toContain('"[data-redis-expiry-mode-content]"');
    expect(viewerSource).toContain('v-model="ttlExpireAt" compact');
    expect(viewerSource.match(/as="button"/g) ?? []).toHaveLength(2);
    expect(viewerSource).toContain(":aria-label=\"t('redis.expiry')\"");
    expect(viewerSource).toContain(":aria-label=\"t('grid.save')\"");
  });

  it("moves keyboard focus to the active TTL editor control", () => {
    const start = findFunction(viewerSource, "startEditTtl").getText();
    const focus = findFunction(viewerSource, "focusTtlExpiryControl").getText();

    expect(start).toContain("focusTtlExpiryControl()");
    expect(focus).toContain('mode === "ttl"');
    expect(focus).toContain("ttlInputEl.value?.$el?.focus()");
    expect(focus).toContain("[data-slot='select-trigger']");
    expect(focus).toContain("[data-date-time-picker-trigger]");
    expect(viewerSource).toContain("if (editingTtl.value && mode !== previousMode) focusTtlExpiryControl(mode);");
  });

  it("serializes expiry saves and preserves unrelated value drafts", () => {
    const save = findFunction(viewerSource, "saveTtl").getText();
    const load = findFunction(viewerSource, "load").getText();

    expect(save).toContain("if (savingTtl.value) return;");
    expect(save).toContain("savingTtl.value = true;");
    expect(save).toContain("await refreshTtlState(error);");
    expect(save).toContain("const refreshError = await refreshTtlState();");
    expect(save).toContain("savingTtl.value = false;");
    expect(load).toContain("const preservedValue = { ...currentValue, ttl: loadedValue.ttl };");
    expect(viewerSource).toContain(':disabled="savingTtl"');
  });

  it("keeps expiry controls compact and inline in the value header", () => {
    expect(viewerSource).toContain("flex min-w-0 max-w-full flex-wrap items-center gap-1");
    expect(viewerSource).toContain('SelectTrigger size="sm"');
    expect(viewerSource).toContain("max-w-[min(100%,14rem)]");
    expect(viewerSource).toContain('v-model="ttlExpireAt" compact');
    expect(viewerSource).not.toContain("full-width");
    expect(viewerSource).not.toContain("basis-full");
    expect(viewerSource).not.toContain("redis-expiry-mode-trigger");
    expect(viewerSource).not.toContain('class="h-6 w-30 text-xs"');
  });

  it("uses the positive-seconds TTL placeholder in both expiration editors", () => {
    const obsoletePlaceholders = {
      en: "empty = no expiry",
      es: "vacío = sin expiración",
      it: "vuoto = senza scadenza",
      ja: "空 = 期限なし",
      "pt-BR": "vazio = sem expiração",
      "zh-CN": "留空表示永不过期",
      "zh-TW": "留空表示永不過期",
    };

    for (const [locale, source] of Object.entries(localeSources)) {
      const ttlPlaceholder = source.match(/createKeyTtlPlaceholder: "([^"]+)"/)?.[1];

      expect(ttlPlaceholder, locale).toBeDefined();
      expect(source, locale).toContain("createKeyPartialWrite:");
      expect(ttlPlaceholder, locale).not.toBe(obsoletePlaceholders[locale as keyof typeof obsoletePlaceholders]);
    }
    expect(browserSource).toContain("t('redis.createKeyTtlPlaceholder')");
    expect(viewerSource).toContain("t('redis.createKeyTtlPlaceholder')");
  });

  it("removes a key that expires while its detail view is refreshing", () => {
    const load = findFunction(viewerSource, "load").getText();
    const deleted = findFunction(browserSource, "onKeyDeleted").getText();
    const loaded = findFunction(browserSource, "onKeyLoaded").getText();

    expect(load).toContain('if (loadedValue.redis_type === "none")');
    expect(load).toContain('emit("deleted", props.keyRaw)');
    expect(deleted).toContain("removeKnownKey(keyRaw)");
    expect(loaded).toContain('if (value.redis_type === "none")');
  });
});
