// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleJobAdmin from "@/components/admin/OracleJobAdmin.vue";
import type { ConnectionConfig } from "@/types/database";
import type { OracleJobsRequest } from "@/lib/database/oracleJobs";

const mocks = vi.hoisted(() => ({ oracleJobs: vi.fn(), ensureConnected: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ oracleJobs: (...args: unknown[]) => mocks.oracleJobs(...args) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const box = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { role: "dialog" }, slots.default?.()) : null,
    }),
    DialogContent: box,
    DialogFooter: box,
    DialogHeader: box,
    DialogTitle: box,
  };
});
let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;
const details = { job: { OWNER: 'App."O', JOB_NAME: "Daily.Job", JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "secret_action", ENABLED: "FALSE", NUMBER_OF_ARGUMENTS: 0, STATE: null, NEXT_RUN_DATE: null }, argumentsAvailability: "available", arguments: [] };
function mount() {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(OracleJobAdmin, { connection: { id: "a", name: "Oracle", db_type: "oracle", database: "svc" } as ConnectionConfig, database: "svc" });
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: {} } }));
  app.mount(root);
}
async function settle() {
  for (let index = 0; index < 16; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
  expect(button).toBeDefined();
  button!.click();
  await settle();
}
const operations = () => mocks.oracleJobs.mock.calls.map((args) => (args[2] as OracleJobsRequest).operation);

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.guard.mockReset().mockImplementation((options) => options.execute());
  mocks.oracleJobs.mockReset().mockImplementation(async (_id, _database, request: OracleJobsRequest) => {
    if (request.operation === "list")
      return { capability: { engine: "oracle", version: "19.0", canManage: true, jobTypes: ["STORED_PROCEDURE", "PLSQL_BLOCK"] }, scheduler: { availability: "available", rows: [details.job] }, legacy: { availability: "available", rows: [{ OWNER: "OLD", JOB_NAME: "7", BROKEN: "N" }] } };
    if (request.operation === "read") return details;
    if (request.operation === "readLegacy") return { legacy: { OWNER: "OLD", JOB_NAME: "7", WHAT: "old_action" }, readOnly: true };
    if (request.operation === "preview") return { revision: "revision-1", before: details, steps: [{ label: "enable", sql: "BEGIN DBMS_SCHEDULER.ENABLE('<job>'); END;" }] };
    return { outcome: "unverified", attemptedSteps: ["enable"], executedSteps: ["enable"], readback: { ...details, job: { ...details.job, ENABLED: null } }, recoveryHint: "Refresh first" };
  });
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
});

describe("OracleJobAdmin production component", () => {
  it("keeps a newly created job selected for immediate editing and enable preview", async () => {
    const original = mocks.oracleJobs.getMockImplementation()!;
    mocks.oracleJobs.mockImplementation(async (...args) => {
      if (args[2].operation === "apply") return { outcome: "unverified", readback: { ...details, job: { ...details.job, OWNER: "TEST", JOB_NAME: "PLAN" } } };
      return original(...args);
    });
    mount();
    await settle();
    await click("JOB 7");
    await click("New disabled job");
    for (const [label, value] of [
      ["Exact owner", "TEST"],
      ["Exact job name", "PLAN"],
    ]) {
      const input = root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    await click("Preview definition");
    await click("Apply reviewed change");
    await click("Preview enable");
    expect(mocks.oracleJobs).toHaveBeenLastCalledWith("a", "svc", { operation: "preview", change: { action: "enable", identity: { owner: "TEST", name: "PLAN" } } });
    await click("Cancel");
    await click("Edit disabled job");
    expect((root.querySelector('input[aria-label="Exact owner"]') as HTMLInputElement).value).toBe("TEST");
    expect((root.querySelector('input[aria-label="Exact job name"]') as HTMLInputElement).value).toBe("PLAN");
  });
  it.each([
    { state: "evaluated", requestedNextRun: "2026-10-11 09:00:00 +08:00", reason: "Engine calendar evaluation only" },
    { state: "unsupported", requestedNextRun: null, reason: "Calendar evaluation is not supported by this engine" },
    { state: "unknown", requestedNextRun: null, reason: "Calendar evaluation was denied; preview is still available" },
  ])("shows requested schedule impact separately from the old next run ($state)", async (impact) => {
    const original = mocks.oracleJobs.getMockImplementation()!;
    mocks.oracleJobs.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[2].operation !== "preview") return response;
      return {
        ...response,
        before: { ...details, job: { ...details.job, NEXT_RUN_DATE: "2026-10-10 09:00:00 +08:00" } },
        scheduleImpact: { ...impact, evaluationAfter: "2026-10-10 08:00:00 +08:00", requestedStartDate: "2026-10-11 09:00:00 +08:00", requestedEndDate: "", requestedRepeatInterval: "FREQ=DAILY" },
      };
    });
    mount();
    await settle();
    await click("New disabled job");
    for (const [label, value] of [
      ["Exact owner", "TEST"],
      ["Exact job name", "PLAN"],
      ["Start date with offset", "2026-10-11 09:00:00 +08:00"],
      ["Repeat interval", "FREQ=DAILY"],
    ]) {
      const input = root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    await click("Preview definition");
    const section = root.querySelector("[data-schedule-impact]");
    expect(section?.textContent).toContain(impact.state);
    expect(section?.textContent).toContain(impact.reason);
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain("2026-10-10 09:00:00 +08:00");
    expect(section?.textContent).toContain(impact.requestedNextRun ?? "Unknown");
    expect(section?.textContent).not.toContain("2026-10-10 09:00:00 +08:00");
    expect(Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Apply reviewed change"))?.disabled).toBe(false);
    await click("Cancel");
    expect(operations()).not.toContain("apply");
  });
  it("only lists and reads when opened/refreshed and preserves exact job identity", async () => {
    mount();
    await settle();
    await click("Refresh");
    await click("Daily.Job");
    expect(operations()).toEqual(["list", "list", "read"]);
    expect(mocks.oracleJobs).toHaveBeenLastCalledWith("a", "svc", { operation: "read", identity: { owner: 'App."O', name: "Daily.Job" } });
    expect(root.textContent).toContain("secret_action");
  });
  it("cancels a preview without applying or invoking the production guard", async () => {
    mount();
    await settle();
    await click("Daily.Job");
    await click("Preview enable");
    await click("Cancel");
    expect(operations()).not.toContain("apply");
    expect(mocks.guard).not.toHaveBeenCalled();
  });
  it("passes only redacted SQL to the production guard and does not turn unknown readback into success", async () => {
    mount();
    await settle();
    await click("Daily.Job");
    await click("Preview enable");
    await click("Apply reviewed change");
    expect(mocks.guard.mock.calls[0][0].reviewText).not.toContain("secret_action");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("not verified");
    expect(root.querySelector('[role="status"]')?.textContent).not.toContain("Readback verified");
  });
  it("keeps legacy jobs visible and read-only", async () => {
    mount();
    await settle();
    await click("JOB 7");
    expect(operations()).toContain("readLegacy");
    expect(root.textContent).toContain("old_action");
    expect(Array.from(root.querySelectorAll("button")).some((item) => item.textContent?.includes("Preview enable"))).toBe(false);
  });
  it("does not expose a sensitive transport exception in the ordinary error message", async () => {
    mocks.oracleJobs.mockRejectedValue(new Error("ORA-27486 secret_action password-secret"));
    mount();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("request failed");
    expect(root.textContent).not.toContain("password-secret");
  });
});
