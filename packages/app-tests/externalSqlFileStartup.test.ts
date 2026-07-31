import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { createOpenTabsRestorationBarrier, initializeDesktopOpenTabs } from "../../apps/desktop/src/lib/app/openTabsStartup.ts";

const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");

test("desktop SQL file opening survives unrelated initialization failure and follows restored tabs", async () => {
  const events: string[] = [];
  const barrier = createOpenTabsRestorationBarrier();
  const fileOpen = (async () => {
    await barrier.settled;
    events.push("read-file");
    events.push("open-tab");
  })();

  await initializeDesktopOpenTabs({
    barrier,
    initializeOptionalState: async () => {
      events.push("initialize-ai-configs");
      throw new Error("AI config storage unavailable");
    },
    restoreOpenTabs: async () => {
      events.push("initialize-editor-settings");
      events.push("initialize-connections");
      events.push("restore-tabs");
    },
    onOptionalStateError: () => events.push("ignore-ai-config-error"),
  });
  await fileOpen;

  assert.deepEqual(events, ["initialize-ai-configs", "ignore-ai-config-error", "initialize-editor-settings", "initialize-connections", "restore-tabs", "read-file", "open-tab"]);
});

test("desktop SQL file opening is released when persisted tab restoration rejects", async () => {
  const events: string[] = [];
  const barrier = createOpenTabsRestorationBarrier();
  const fileOpen = barrier.settled.then(() => events.push("open-file"));

  await assert.rejects(
    initializeDesktopOpenTabs({
      barrier,
      initializeOptionalState: async () => {},
      restoreOpenTabs: async () => {
        events.push("restore-tabs");
        throw new Error("corrupt persisted tabs");
      },
      onOptionalStateError: () => {},
    }),
    /corrupt persisted tabs/,
  );
  await fileOpen;

  assert.deepEqual(events, ["restore-tabs", "open-file"]);
});

test("cold-start SQL files wait for restored tabs before opening", () => {
  const openPathStart = appSource.indexOf("async function openSqlFilePath");
  const openPathEnd = appSource.indexOf("async function openPendingSqlFiles", openPathStart);
  assert.ok(openPathStart >= 0 && openPathEnd > openPathStart);

  const openPathSource = appSource.slice(openPathStart, openPathEnd);
  const initializationWait = openPathSource.indexOf("await desktopOpenTabsRestorationBarrier?.settled");
  const fileRead = openPathSource.indexOf("api.readExternalSqlFile(path)");
  const tabOpen = openPathSource.indexOf("queryStore.openExternalSqlFile");
  assert.ok(initializationWait >= 0);
  assert.ok(initializationWait < fileRead);
  assert.ok(fileRead < tabOpen);

  const mountedStart = appSource.indexOf("onMounted(async () =>");
  const mountedEnd = appSource.indexOf("onUnmounted(", mountedStart);
  assert.ok(mountedStart >= 0 && mountedEnd > mountedStart);

  const mountedSource = appSource.slice(mountedStart, mountedEnd);
  const barrierCreation = mountedSource.indexOf("desktopOpenTabsRestorationBarrier = createOpenTabsRestorationBarrier()");
  const initializationStart = mountedSource.indexOf("void initApp()", barrierCreation);
  const listenerSetup = mountedSource.indexOf("setupTauriListeners()", initializationStart);
  const pendingFileOpen = mountedSource.indexOf("openPendingSqlFiles()");
  assert.ok(barrierCreation >= 0);
  assert.ok(initializationStart >= 0);
  assert.ok(barrierCreation < initializationStart);
  assert.ok(initializationStart < listenerSetup);
  assert.ok(listenerSetup < pendingFileOpen);
  assert.ok(initializationStart < pendingFileOpen);
});
