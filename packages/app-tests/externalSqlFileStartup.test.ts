import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { createOpenTabsRestorationBarrier, initializeDesktopOpenTabs, initializeOpenTabs } from "../../apps/desktop/src/lib/app/openTabsStartup.ts";

const appSource = readFileSync("apps/desktop/src/App.vue", "utf8");

test("web startup reports optional initialization failure and continues restoring persisted state", async () => {
  const events: string[] = [];
  let reportError!: () => void;
  const errorReported = new Promise<void>((resolve) => {
    reportError = resolve;
  });

  await initializeOpenTabs({
    initializeOptionalState: async () => {
      events.push("initialize-ai-configs");
      throw new Error("AI config storage unavailable");
    },
    restoreOpenTabs: async () => {
      events.push("initialize-editor-settings");
      events.push("initialize-connections");
      events.push("restore-tabs");
    },
    onOptionalStateError: () => {
      events.push("report-ai-config-error");
      reportError();
    },
  });

  await errorReported;
  assert.deepEqual(
    events.filter((event) => !event.includes("ai-config")),
    ["initialize-editor-settings", "initialize-connections", "restore-tabs"],
  );
  assert.ok(events.includes("report-ai-config-error"));
});

test("shared startup initializes optional state once and propagates required restoration failure", async () => {
  let optionalInitializationCount = 0;

  await assert.rejects(
    initializeOpenTabs({
      initializeOptionalState: async () => {
        optionalInitializationCount += 1;
      },
      restoreOpenTabs: async () => {
        throw new Error("persisted connections unavailable");
      },
      onOptionalStateError: () => assert.fail("successful optional initialization must not be reported"),
    }),
    /persisted connections unavailable/,
  );

  assert.equal(optionalInitializationCount, 1);
});

test("web startup uses the guarded initializer behind the existing authentication gate", () => {
  const initAppStart = appSource.indexOf("async function initApp()");
  const initAppEnd = appSource.indexOf("function restoreActiveConnectionContext", initAppStart);
  assert.ok(initAppStart >= 0 && initAppEnd > initAppStart);

  const initAppSource = appSource.slice(initAppStart, initAppEnd);
  const webInitialization = initAppSource.indexOf("await initializeOpenTabs({");
  const optionalInitialization = initAppSource.indexOf("initializeOptionalState: () => settingsStore.initAiConfigs()", webInitialization);
  const requiredRestoration = initAppSource.indexOf("restoreOpenTabs,", optionalInitialization);
  const savedSqlInitialization = initAppSource.indexOf("savedSqlStore.initFromStorage()", requiredRestoration);
  assert.ok(webInitialization >= 0);
  assert.ok(optionalInitialization > webInitialization);
  assert.ok(requiredRestoration > optionalInitialization);
  assert.ok(savedSqlInitialization > requiredRestoration);
  assert.equal(initAppSource.includes("if (!desktopOpenTabsRestorationBarrier) await settingsStore.initAiConfigs()"), false);

  const mountedStart = appSource.indexOf("onMounted(async () =>");
  const mountedEnd = appSource.indexOf("onUnmounted(", mountedStart);
  assert.ok(mountedStart >= 0 && mountedEnd > mountedStart);

  const mountedSource = appSource.slice(mountedStart, mountedEnd);
  const cachedAuth = mountedSource.indexOf("if (!startupProps.startupAuthentication)");
  const authCheck = mountedSource.indexOf("await checkStartupAuthentication()", cachedAuth);
  const loginRedirect = mountedSource.indexOf('history.replaceState(null, "", webPath("/login"))', authCheck);
  const authenticatedInitialization = mountedSource.indexOf("if (!setupRequired.value && (!needsAuth.value || authenticated.value)) void initApp()", loginRedirect);
  assert.ok(cachedAuth >= 0 && authCheck > cachedAuth);
  assert.ok(loginRedirect > authCheck);
  assert.ok(authenticatedInitialization > loginRedirect);
});

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

  await Promise.resolve();
  assert.deepEqual(
    events.filter((event) => !event.includes("ai-config")),
    ["initialize-editor-settings", "initialize-connections", "restore-tabs", "read-file", "open-tab"],
  );
  assert.ok(events.includes("ignore-ai-config-error"));
});

test("pending optional AI initialization does not hold tab restoration or external file opening", async () => {
  let rejectOptional!: (error: Error) => void;
  const optional = new Promise<void>((_resolve, reject) => {
    rejectOptional = reject;
  });
  const errors: unknown[] = [];
  const barrier = createOpenTabsRestorationBarrier();
  const events: string[] = [];
  const fileOpen = barrier.settled.then(() => events.push("open-file"));
  await initializeDesktopOpenTabs({
    barrier,
    initializeOptionalState: () => optional,
    restoreOpenTabs: async () => {
      events.push("restore-tabs");
    },
    onOptionalStateError: (error) => errors.push(error),
  });
  await fileOpen;
  assert.deepEqual(events, ["restore-tabs", "open-file"]);
  const error = new Error("AI config unavailable");
  rejectOptional(error);
  await optional.catch(() => {});
  await Promise.resolve();
  assert.deepEqual(errors, [error]);
});

test("a synchronous optional initialization failure does not block required restoration", async () => {
  const events: string[] = [];
  await initializeOpenTabs({
    initializeOptionalState: () => {
      throw new Error("optional failure");
    },
    restoreOpenTabs: async () => {
      events.push("restored");
    },
    onOptionalStateError: () => {
      events.push("reported");
    },
  });
  await Promise.resolve();
  assert.deepEqual(events, ["restored", "reported"]);
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
