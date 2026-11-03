// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

import StackTracePanel from "../StackTracePanel.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App;
let root: HTMLDivElement;
let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof usePlDebugStore>;

beforeEach(() => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("frame source must not query a guessed dictionary object");
    }),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  store = usePlDebugStore();
  store.debugId = "original";
  store.connectionId = "conn";
  store.database = "APP";
  store.publicSnapshot = { stopRevision: 7, state: "paused" } as PlDebugSnapshot;
  store.status = {
    frames: [
      {
        nativeFrameId: 2,
        line: 4,
        program: "Pkg.With.Dot\nName",
        sourceState: "resolved",
        sourceRef: {
          id: "original:source",
          sourceRevision: 1,
          stopRevision: 7,
          nativeFrameId: 2,
          lineBasis: "all_source",
          identityState: "native",
          evidenceKind: "runtime",
          objectType: "PACKAGE BODY",
          owner: "Exact Owner",
          name: "Pkg.With.Dot\nName",
          source: "PACKAGE BODY exact AS\n-- frozen source\nEND;",
        },
      },
    ],
  };
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(StackTracePanel);
  app.use(pinia).mount(root);
});

afterEach(() => {
  app.unmount();
  root.remove();
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

it("shows the exact server-owned source snapshot without resolving the frame label", async () => {
  const button = root.querySelector<HTMLButtonElement>('button[title="plDebug.frameSource.view"]');
  expect(button).not.toBeNull();
  button!.click();
  await nextTick();
  expect(store.frameSourceView).toMatchObject({ frameIndex: 0, owner: "Exact Owner", name: "Pkg.With.Dot\nName", line: 4, source: "PACKAGE BODY exact AS\n-- frozen source\nEND;", error: null });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([false, true])("keeps bracketed text diagnostic while preserving legacy frame selection: %s", async (verifiedProtocol) => {
  store.status = verifiedProtocol ? { frameMappingState: "unavailable" } : {};
  store.backtrace = "[Line 2] PKG.RUN\n[Line 19] __anonymous_block__";
  store.stackError = "collection failed · HY001 · 600";
  const select = vi.spyOn(store, "selectFrame").mockResolvedValue();
  await nextTick();
  expect(root.textContent).toContain("PKG.RUN");
  expect(root.textContent).toContain("collection failed · HY001 · 600");
  const row = Array.from(root.querySelectorAll<HTMLButtonElement>("li button")).find((button) => button.textContent?.includes("__anonymous_block__"))!;
  expect(row.disabled).toBe(verifiedProtocol);
  row.click();
  await nextTick();
  expect(select).toHaveBeenCalledTimes(verifiedProtocol ? 0 : 1);
  expect(root.querySelector('button[title="plDebug.frameSource.view"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps confirmed frame positions selectable when their source identity is unknown", async () => {
  store.status = { frameMappingState: "verified", frames: [{ frameIndex: 1, nativeFrameId: 1, program: null, sourceState: "unknown" }] };
  const select = vi.spyOn(store, "selectFrame").mockResolvedValue();
  store.currentFrame = 1;
  await nextTick();
  const row = root.querySelector<HTMLButtonElement>("li button")!;
  expect(row.disabled).toBe(false);
  row.click();
  await nextTick();
  expect(select).toHaveBeenCalledWith(0);
});

it.each(["unresolved", "stale", "wrongFrame", "recovering", "busy", "running"])("does not guess a source when the native reference is %s", async (reason) => {
  const frame = store.status!.frames![0]!;
  if (reason === "unresolved") frame.sourceState = "unresolved";
  if (reason === "stale") frame.sourceRef!.stopRevision = 6;
  if (reason === "wrongFrame") frame.sourceRef!.nativeFrameId = 1;
  if (reason === "recovering") store.recoveryRequired = true;
  if (reason === "busy") store.busy = true;
  if (reason === "running") store.publicSnapshot!.state = "running";
  await nextTick();
  expect(root.querySelector('button[title="plDebug.frameSource.view"]')).toBeNull();
  expect(store.frameSourceView).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
