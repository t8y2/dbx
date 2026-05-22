import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");
const appDialogsSource = readFileSync("apps/desktop/src/components/layout/AppDialogs.vue", "utf8");
const contentAreaSource = readFileSync("apps/desktop/src/components/layout/ContentArea.vue", "utf8");
const i18nSource = readFileSync("apps/desktop/src/i18n/index.ts", "utf8");
const mainSource = readFileSync("apps/desktop/src/main.ts", "utf8");

test("app defers cold-start side panels and modal pages behind async components", () => {
  assert.match(appSource, /defineAsyncComponent/);
  for (const component of ["AiAssistant", "QueryHistory", "DriverStorePage", "UpdateDialog", "LoginPage"]) {
    assert.doesNotMatch(appSource, new RegExp(`import ${component} from`));
    assert.match(appSource, new RegExp(`const ${component} = defineAsyncComponent`));
  }
});

test("AI assistant panel stays closed on first launch to preserve startup memory", () => {
  assert.match(appSource, /const showAiPanel = ref\(localStorage\.getItem\("dbx-ai-panel-open"\) === "true"\)/);
});

test("app dialogs keep non-primary dialogs out of the startup chunk", () => {
  for (const component of ["ConnectionDialog", "EditorSettingsDialog", "DangerConfirmDialog"]) {
    assert.doesNotMatch(appDialogsSource, new RegExp(`import ${component} from`));
    assert.match(appDialogsSource, new RegExp(`const ${component} = defineAsyncComponent`));
  }
});

test("app dialogs only render async dialogs when their open state needs them", () => {
  assert.match(
    appDialogsSource,
    /const shouldShowConnectionDialog = computed\(\(\) => props\.showConnectionDialog \|\| !!editConfig\.value\)/,
  );
  assert.match(appDialogsSource, /<ConnectionDialog\s+v-if="shouldShowConnectionDialog"/);
  assert.match(appDialogsSource, /<EditorSettingsDialog\s+v-if="showSettingsDialog"/);
  assert.match(appDialogsSource, /<DangerConfirmDialog\s+v-if="showDangerDialog"/);
  assert.match(appDialogsSource, /<DataTransferDialog\s+v-if="dialogs\.showTransferDialog\.value"/);
  assert.match(appDialogsSource, /<SchemaDiagramDialog\s+v-if="dialogs\.showDiagramDialog\.value"/);
  assert.match(appDialogsSource, /<DatabaseExportDialog\s+v-if="dialogs\.showDatabaseExportDialog\.value"/);
});

test("content area defers database-specific browsers behind async components", () => {
  assert.match(contentAreaSource, /defineAsyncComponent/);
  for (const component of ["DataGrid", "RedisKeyBrowser", "MongoDocBrowser", "ObjectBrowser"]) {
    assert.doesNotMatch(contentAreaSource, new RegExp(`import ${component} from`));
    assert.match(contentAreaSource, new RegExp(`const ${component} = defineAsyncComponent`));
  }
});

test("i18n defers non-default locale payloads out of the startup chunk", () => {
  assert.doesNotMatch(i18nSource, /import en from "\.\/locales\/en"/);
  assert.doesNotMatch(i18nSource, /import es from "\.\/locales\/es"/);
  assert.match(i18nSource, /const localeLoaders/);
  assert.match(i18nSource, /en:\s*\(\)\s*=>\s*import\("\.\/locales\/en"\)/);
  assert.match(i18nSource, /es:\s*\(\)\s*=>\s*import\("\.\/locales\/es"\)/);
  assert.match(mainSource, /loadSavedLocale\(\)/);
  assert.match(mainSource, /app\.mount\("#root"\)/);
});
