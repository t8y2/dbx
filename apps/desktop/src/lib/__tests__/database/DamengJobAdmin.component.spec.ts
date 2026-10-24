// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeJobDetails, NativeJobRequest } from "@/lib/database/nativeJobs";
import type { ConnectionConfig } from "@/types/database";
import type { NativeJobAdminSelection } from "@/lib/database/nativeJobAdmin";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  executeQuery: vi.fn(),
  executeMulti: vi.fn(),
  nativeJobOpenContext: vi.fn(),
  nativeJobList: vi.fn(),
  nativeJobRead: vi.fn(),
  nativeJobReferences: vi.fn(),
  nativeJobPrepare: vi.fn(),
  nativeJobApply: vi.fn(),
  nativeJobStatus: vi.fn(),
  nativeJobCancel: vi.fn(),
  toast: vi.fn(),
  track: vi.fn(),
}));
function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}
function modelDialog() {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => (attrs.open ? h("div", { "data-dialog": "true" }, slots.default?.()) : null);
    },
  });
}
function modelInput() {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs }) {
      return () => h("input", { ...attrs, value: attrs.modelValue, onInput: (event: Event) => (attrs["onUpdate:modelValue"] as (value: string) => void)?.((event.target as HTMLInputElement).value) });
    },
  });
}
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
vi.mock("@/components/ui/input", () => ({ Input: modelInput() }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: modelDialog(), DialogContent: passthrough("div"), DialogFooter: passthrough("div"), DialogHeader: passthrough("div"), DialogTitle: passthrough("div") }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/tabs/tabUiState", () => ({ useTabUiState: () => ({ initialState: { selectedJobName: "Job_1", detailTab: "steps" }, track: mocks.track }) }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: async (options: { execute: () => Promise<unknown> }) => options.execute(), executeWithProductionSqlGuard: async (options: { execute: () => Promise<unknown> }) => options.execute() }));
import DamengJobAdmin from "@/components/admin/DamengJobAdmin.vue";

const scope = { connectionId: "c", database: "", contextId: "context" };
const target = { kind: "dameng-native" as const, scope, jobId: "900719925474099312345", name: "Job_1" };
const connection: ConnectionConfig = { id: "c", name: "DM test", db_type: "dameng", host: "localhost", port: 5236, username: "Owner", password: "" };
let details: NativeJobDetails;
let request: NativeJobRequest | undefined;
const mounted: { app: ReturnType<typeof createApp>; root: HTMLDivElement }[] = [];
async function flush() {
  for (let index = 0; index < 24; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function mount(config: ConnectionConfig = connection, initialSelection?: NativeJobAdminSelection) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(DamengJobAdmin, { connection: config, initialSelection });
  app.mount(root);
  mounted.push({ app, root });
  await flush();
  return root;
}
function button(root: Element, label: string) {
  const active = root.querySelector('[data-dialog="true"]') ?? root;
  const result = [...active.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
function input(root: Element, label: string, value: string) {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing input ${label}`);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
beforeEach(() => {
  vi.resetAllMocks();
  request = undefined;
  details = {
    snapshot: {
      ref: target,
      revision: "baseline",
      definition: { status: "available", value: { ID: target.jobId, NAME: "Job_1", USERNAME: "Owner", ENABLE: false, DESCRIBE: "old description", ENABLE_EMAIL: false, EMAIL_TYPE: 2, ENABLE_NETSEND: false, NETSEND_TYPE: 2, EP_SEQNO: 0, RAFT_NAME: null } },
      arguments: { status: "empty" },
    },
    nativeIdentity: { status: "available", value: { DBX_JOB_ID: target.jobId, DBX_CREATED_AT: "creation" } },
    consistency: { status: "available", value: null },
    parameterMetadata: { status: "unsupported", reason: "not_applicable" },
    steps: { status: "available", value: [{ ID: 11, JOBID: target.jobId, NAME: "sql", TYPE: 0, COMMAND: "SELECT 1;", SUCC_ACTION: 1, FAIL_ACTION: 1, RETRY_ATTEMPTS: 0, RETRY_INTERVAL: 0, APPEND_FLAG: 0, DESCRIBE: null, SUCC_NEXT_STEP: null, FAIL_NEXT_STEP: null }] },
    schedules: { status: "empty" },
    running: { status: "unknown", reason: "not_readable" },
    history: { status: "denied", reason: "privilege_missing" },
    sources: {},
  };
  mocks.executeQuery.mockResolvedValue({ columns: ["CNT"], rows: [[1]], affected_rows: 0, execution_time_ms: 0 });
  mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "dameng", sessionUser: "Owner", actualDatabase: "DB", productVersion: "8" });
  mocks.nativeJobList.mockImplementation(async () => ({
    jobs: { status: "available", value: [{ ref: target, name: "Job_1", owner: "Owner", enabled: false, jobType: "native", state: null, nextRun: null, comments: "old description", aliases: [], logUser: null, privUser: null, schemaUser: null }] },
    source: { source: "SYSJOB.USER_JOBS_VIEW", coverage: "current_user" },
    offset: 0,
    limit: 100,
  }));
  mocks.nativeJobRead.mockImplementation(async () => structuredClone(details));
  mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
    request = value;
    return { planId: "immutable-plan", operationId: "operation", scope, target, steps: [{ id: "definition", label: "native_job_step_definition", sql: "native reviewed SQL" }] };
  });
  mocks.nativeJobApply.mockResolvedValue({ operationId: "operation", target, state: "finished", outcome: "verified", cancelRequested: false, steps: [{ id: "definition", state: "applied", reason: null, vendorCode: null }], reason: null });
});
afterEach(() => {
  for (const { app, root } of mounted.splice(0)) {
    app.unmount();
    root.remove();
  }
  vi.useRealTimers();
});

function schedulerRefreshFixture(options: { sameScope?: boolean; replaced?: boolean; unknownIdentity?: boolean; sessionUser?: string; actualDatabase?: string } = {}) {
  const nextScope = options.sameScope ? scope : { ...scope, contextId: "reconnected" };
  const ref = { kind: "scheduler" as const, scope, owner: "Owner", name: "Job_1" };
  let opened = 0;
  mocks.nativeJobOpenContext.mockImplementation(async () => {
    opened++;
    return { scope: opened === 1 ? scope : nextScope, engine: "oceanbase-oracle", sessionUser: opened === 1 ? "Owner" : (options.sessionUser ?? "Owner"), actualDatabase: opened === 1 ? "DB" : (options.actualDatabase ?? "DB"), productVersion: "4.2.5.7" };
  });
  mocks.nativeJobList.mockImplementation(async ({ scope: requested }) => ({ jobs: { status: "available", value: [{ ref: { ...ref, scope: requested }, name: ref.name, owner: ref.owner, enabled: false, aliases: [] }] }, source: { coverage: "current_user" }, offset: 0, limit: 100 }));
  const read = (requested: typeof ref) => {
    const value = structuredClone(details);
    value.snapshot.ref = requested;
    value.snapshot.revision = opened === 1 ? "baseline" : "fresh-baseline";
    value.snapshot.definition = { status: "available", value: { JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "work_proc", NUMBER_OF_ARGUMENTS: 0, JOB_STYLE: "REGULAR", ENABLED: false, AUTO_DROP: false, JOB_CLASS: "DEFAULT_JOB_CLASS", MAX_FAILURES: 0, MAX_RUN_DURATION: "0 0:0:0.0" } };
    value.nativeIdentity = opened > 1 && options.unknownIdentity ? { status: "unknown", reason: "identity_unavailable" } : { status: "available", value: { DBX_JOB_ID: "41", DBX_CREATED_AT: opened > 1 && options.replaced ? "replacement" : "creation" } };
    value.snapshot.arguments = { status: "empty" };
    return value;
  };
  mocks.nativeJobRead.mockImplementation(async (requested) => read(requested));
  mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
    request = value;
    if (!("target" in value)) throw new Error("Expected an existing target");
    return { planId: "immutable-plan", operationId: "operation", scope: value.target.scope, target: value.target, steps: [{ id: "attributes", label: "attributes", sql: "reviewed effective native attribute" }] };
  });
  return { ref, nextScope, read, config: { ...connection, db_type: "oceanbase-oracle" as const } };
}

describe("native Job explicit context recovery", () => {
  it("keeps a dispatched Run and independent Stop separate while a late Run receipt cannot close Stop confirmation", async () => {
    vi.useFakeTimers();
    const fixture = schedulerRefreshFixture();
    details.running = { status: "empty" };
    let finishRun!: (status: unknown) => void;
    const runReceipt = new Promise((resolve) => (finishRun = resolve));
    let runFinished = false;
    const operation = (action: "run" | "stop", finished = false) => ({
      operationId: `${action}-operation`,
      target: fixture.ref,
      state: finished ? "finished" : "running",
      outcome: finished ? "accepted" : "unknown",
      cancelRequested: false,
      steps: [{ id: action, state: finished ? "accepted" : "dispatching", reason: null, vendorCode: null }],
      reason: null,
    });
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => ({ planId: `${value.action}-plan`, operationId: `${value.action}-operation`, scope, target: fixture.ref, steps: [{ id: value.action, label: value.action, sql: `reviewed ${value.action}` }] }));
    mocks.nativeJobApply.mockImplementation(async (planId: string) => (planId === "run-plan" ? runReceipt : operation("stop", true)));
    mocks.nativeJobStatus.mockImplementation(async (id: string) => operation(id === "run-operation" ? "run" : "stop", id === "run-operation" ? runFinished : true));
    const root = await mount(fixture.config);
    expect(button(root, "damengJobAdmin.stopRunning").disabled).toBe(true);
    button(root, "damengJobAdmin.runAsync").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(button(root, "damengJobAdmin.stopRunning").disabled).toBe(false);
    expect(button(root, "nativeJobs.editJob").disabled).toBe(true);
    button(root, "damengJobAdmin.stopRunning").click();
    await flush();
    expect(root.querySelector('[data-dialog="true"]')?.textContent).toContain("reviewed stop");
    expect(button(root, "damengJobAdmin.applySql").disabled).toBe(false);
    finishRun(operation("run", true));
    await flush();
    expect(root.querySelector('[data-dialog="true"]')?.textContent).toContain("reviewed stop");
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(mocks.nativeJobApply.mock.calls.map(([id]) => id)).toEqual(["run-plan", "stop-plan"]);
    expect(root.textContent).toContain("nativeJobs.outcomes.running");
    expect(root.textContent).toContain("nativeJobs.outcomes.accepted");
    runFinished = true;
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(mocks.nativeJobStatus.mock.calls.every(([id]) => id === "run-operation" || id === "stop-operation")).toBe(true);
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(2);
  });
  it("keeps rejected precision inputs editable and allows a corrected creation preview without applying", async () => {
    const fixture = schedulerRefreshFixture();
    const root = await mount(fixture.config);
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "Precision_job");
    input(root, "nativeJobs.definitionFields.START_DATE", "2032-01-01T23:54:25.123456789Z");
    input(root, "nativeJobs.definitionFields.END_DATE", "2032-01-02T00:04:25.987654321Z");
    mocks.nativeJobPrepare.mockRejectedValueOnce(new Error("native_job_timestamp_precision_microseconds"));
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.datePrecisionMicroseconds");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.START_DATE"]')!.value).toBe("2032-01-01T23:54:25.123456789Z");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.END_DATE"]')!.value).toBe("2032-01-02T00:04:25.987654321Z");
    mocks.nativeJobPrepare.mockResolvedValueOnce({ planId: "corrected-plan", operationId: "corrected-operation", scope, target: { ...fixture.ref, name: "Precision_job" }, steps: [{ id: "create", label: "create", sql: "reviewed create" }] });
    input(root, "nativeJobs.definitionFields.START_DATE", "2032-01-01T23:54:25.123456000Z");
    input(root, "nativeJobs.definitionFields.END_DATE", "2032-01-02T00:04:25.987654000Z");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(root.textContent).toContain("reviewed create");
    expect(mocks.nativeJobPrepare).toHaveBeenLastCalledWith(expect.objectContaining({ action: "create", definition: expect.objectContaining({ startDate: "2032-01-01T23:54:25.123456000Z", endDate: "2032-01-02T00:04:25.987654000Z" }) }));
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });

  it("keeps a failed refresh draft readable without reusing its previous baseline", async () => {
    const fixture = schedulerRefreshFixture();
    const root = await mount(fixture.config);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_FAILURES", "2");
    button(root, "common.cancel").click();
    await flush();
    mocks.nativeJobOpenContext.mockRejectedValueOnce(new Error("refresh_connection_failed"));
    button(root, "contextMenu.refreshChildren").click();
    await flush();
    expect(root.textContent).toContain("refresh_connection_failed");
    button(root, "nativeJobs.viewRetainedDraft").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    const retained = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_FAILURES"]')!;
    expect(retained.value).toBe("2");
    expect(retained.disabled).toBe(true);
    expect(mocks.nativeJobPrepare).not.toHaveBeenCalled();
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });

  it("discards an old detail read after installing a fresh context", async () => {
    const fixture = schedulerRefreshFixture();
    let finish!: (value: NativeJobDetails) => void;
    mocks.nativeJobRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const root = await mount(fixture.config);
    button(root, "contextMenu.refreshChildren").click();
    await flush();
    const old = fixture.read(fixture.ref);
    old.snapshot.revision = "late-old-baseline";
    finish(old);
    await flush();
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_FAILURES", "2");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ target: { scope: fixture.nextScope }, baseline: "fresh-baseline" });
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });

  it("loads a cold Generic OceanBase page only after mode discovery and rejects late context after withdrawal", async () => {
    const fixture = schedulerRefreshFixture();
    const config = reactive({ ...fixture.config, db_type: "jdbc" as const, database_info: { productName: "OceanBase" } });
    let finish!: (value: unknown) => void;
    mocks.nativeJobOpenContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const root = await mount(config);
    expect(mocks.nativeJobOpenContext).not.toHaveBeenCalled();
    config.database_info = { productName: "OceanBase", compatibilityMode: "oracle" };
    await flush();
    expect(mocks.nativeJobOpenContext).toHaveBeenCalledTimes(1);
    config.database_info = { productName: "OceanBase", compatibilityMode: "mysql" };
    await flush();
    finish({ scope, engine: "oceanbase-oracle", sessionUser: "Owner", actualDatabase: "DB" });
    await flush();
    expect(root.textContent).toContain("nativeJobs.unsupported");
    expect(mocks.nativeJobList).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.nativeJobPrepare).not.toHaveBeenCalled();
  });

  it("reconnects with a fresh scope and baseline while retaining the same object's MAX_FAILURES draft", async () => {
    const fixture = schedulerRefreshFixture();
    const root = await mount(fixture.config);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_FAILURES", "2");
    mocks.nativeJobPrepare.mockRejectedValueOnce(new Error("native_job_context_changed"));
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_FAILURES"]')!.value).toBe("2");
    button(root, "common.cancel").click();
    await flush();
    button(root, "contextMenu.refreshChildren").click();
    await flush();
    expect(mocks.nativeJobOpenContext).toHaveBeenCalledTimes(2);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_FAILURES"]')!.value).toBe("2");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: { ...fixture.ref, scope: fixture.nextScope }, baseline: "fresh-baseline", attributes: [{ name: "MAX_FAILURES", change: { kind: "set", value: 2 } }] });
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });

  it.each([{ replaced: true }, { unknownIdentity: true }, { sessionUser: "Other" }, { actualDatabase: "OTHER_DB" }])("retains an unbound read-only draft rather than applying it after identity changes: %j", async (options) => {
    const fixture = schedulerRefreshFixture(options);
    const root = await mount(fixture.config);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_FAILURES", "2");
    button(root, "common.cancel").click();
    await flush();
    button(root, "contextMenu.refreshChildren").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.detachedDraft");
    button(root, "nativeJobs.viewRetainedDraft").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    const retained = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_FAILURES"]')!;
    expect(retained.value).toBe("2");
    expect(retained.disabled).toBe(true);
    expect([...root.querySelectorAll("button")].some((item) => item.textContent?.trim() === "damengJobAdmin.previewSql")).toBe(false);
    expect(mocks.nativeJobPrepare).not.toHaveBeenCalled();
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });

  it("does not clear fresh same-scope drafts when a pre-refresh operation finishes late", async () => {
    const fixture = schedulerRefreshFixture({ sameScope: true });
    let finish!: (value: unknown) => void;
    mocks.nativeJobApply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const root = await mount(fixture.config);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_FAILURES", "2");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    const refresh = [...root.querySelectorAll("button")].find((element) => element.textContent?.trim() === "contextMenu.refreshChildren")!;
    refresh.click();
    await flush();
    finish({ operationId: "operation", target: fixture.ref, state: "finished", outcome: "verified", cancelRequested: false, steps: [{ id: "attributes", state: "applied", reason: null, vendorCode: null }], reason: null });
    await flush();
    expect(root.textContent).toContain("nativeJobs.previousContext");
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(1);
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_FAILURES"]')!.value).toBe("2");
    expect(mocks.toast).not.toHaveBeenCalledWith("damengJobAdmin.applySuccess", 2500);
  });
});

describe("existing Dameng Job management entry", () => {
  it.each(["partial", "unknown"] as const)("follows a verified renamed identity and retains remaining edits after %s", async (outcome) => {
    const renamed = { ...target, name: "Renamed Job" };
    let changed = false;
    mocks.nativeJobList.mockImplementation(async () => ({
      jobs: { status: "available", value: [{ ref: changed ? renamed : target, name: changed ? renamed.name : target.name, owner: "Owner", enabled: false, aliases: [] }] },
      source: { source: "SYSJOB.SYSJOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    }));
    mocks.nativeJobRead.mockImplementation(async (requested) => {
      const value = structuredClone(details);
      value.snapshot.ref = requested;
      if (changed && requested.name === target.name) {
        value.snapshot.definition = { status: "empty" };
        value.nativeIdentity = { status: "empty" };
      } else if (changed && value.snapshot.definition.status === "available") value.snapshot.definition.value.NAME = renamed.name;
      return value;
    });
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      if (value.action !== "configure-dameng") throw new Error("expected native edit");
      const rename = value.configuration.attributes?.some((attribute) => attribute.name === "NAME");
      return {
        planId: "rename-plan",
        operationId: "rename-operation",
        scope,
        target: value.target,
        steps: rename
          ? [
              { id: "rename", label: "rename", sql: "reviewed rename and commit" },
              { id: "enable", label: "enable", sql: "reviewed activation" },
            ]
          : [{ id: "enable", label: "enable", sql: "remaining activation" }],
      };
    });
    const observed = { DBX_JOB_ID: target.jobId, DBX_CREATED_AT: "creation", NAME: renamed.name };
    const result = {
      operationId: "rename-operation",
      target: outcome === "partial" ? renamed : target,
      observedIdentity: outcome === "partial" ? observed : undefined,
      state: "finished",
      outcome,
      cancelRequested: false,
      steps: [
        { id: "rename", state: outcome === "partial" ? "applied" : "unknown", reason: null, vendorCode: null },
        { id: "enable", state: "skipped", reason: null, vendorCode: null },
      ],
      reason: outcome === "unknown" ? "native_job_rename_commit_unknown" : "native_job_step_not_applied",
    };
    mocks.nativeJobApply.mockImplementation(async () => {
      changed = true;
      return result;
    });
    const root = await mount();
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.fields.NAME", renamed.name);
    const enabled = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.fields.ENABLE"]')!;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    if (outcome === "unknown") {
      expect(mocks.nativeJobRead).toHaveBeenLastCalledWith(target);
      mocks.nativeJobStatus.mockResolvedValue({ ...result, target: renamed, observedIdentity: observed });
      button(root, "nativeJobs.checkResult").click();
      await flush();
      expect(mocks.nativeJobStatus).toHaveBeenCalledExactlyOnceWith("rename-operation", true);
    }
    expect(mocks.nativeJobRead).toHaveBeenLastCalledWith(renamed);
    expect(root.textContent).toContain(renamed.name);
    button(root, "nativeJobs.correctDraft").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.fields.NAME"]')!.value).toBe(renamed.name);
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.fields.ENABLE"]')!.checked).toBe(true);
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ target: renamed, configuration: { attributes: [{ name: "ENABLE", change: { kind: "set", value: true } }] } });
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(1);
  });
  it("reports a committed custom Legacy interval without implying a pending business run", async () => {
    const legacy = { kind: "legacy" as const, scope, jobId: target.jobId };
    details.snapshot.ref = legacy;
    details.legacyDefinition = { status: "available", value: { DBX_JOB_ID: target.jobId, WHAT: "work();", NEXT_DATE: "native date", INTERVAL: "86400", INSTANCE: 1 } };
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "Job_1", owner: "Owner", enabled: false, aliases: [] }] }, source: { source: "SYSJOB.SYSJOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      return { planId: "interval-plan", operationId: "interval-operation", scope, target: legacy, steps: [{ id: "legacy_interval", label: "native_job_step_attribute", sql: "reviewed interval and commit" }] };
    });
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "interval-operation",
      target: legacy,
      state: "finished",
      outcome: "accepted",
      cancelRequested: false,
      steps: [{ id: "legacy_interval", state: "accepted", reason: "native_job_legacy_interval_expression_not_readable", vendorCode: null }],
      reason: "native_job_legacy_interval_expression_not_readable",
    });
    const root = await mount(connection, { kind: "legacy", jobId: target.jobId });
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.damengInterval", "SYSDATE + custom_next()");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(request).toMatchObject({ target: legacy, attributes: [{ name: "INTERVAL", change: { kind: "set", value: "SYSDATE + custom_next()" } }] });
    expect(root.textContent).toContain("nativeJobs.damengIntervalAccepted");
    expect(root.textContent).not.toContain("nativeJobs.outcomes.accepted");
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(1);
    expect(mocks.nativeJobStatus).not.toHaveBeenCalled();
  });
  it.each(["available", "denied"] as const)("preserves old DM Legacy child tabs and history clearing when DBMS_JOB metadata is %s", async (status) => {
    const legacy = { kind: "legacy" as const, scope, jobId: target.jobId };
    details.snapshot.ref = legacy;
    details.legacyDefinition = status === "available" ? { status, value: { WHAT: "work();", NEXT_DATE: "native date", INTERVAL: "86400" } } : { status, reason: "privilege_missing" };
    details.schedules = { status: "available", value: [{ ID: 12, JOBID: target.jobId, NAME: "old_schedule" }] };
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "Job_1", owner: "Owner", enabled: false, aliases: [] }] }, source: { source: "SYSJOB.SYSJOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      return { planId: "clear-history-plan", operationId: "clear-history-operation", scope, target: legacy, steps: [{ id: "clear_history", label: "clear_history", sql: "reviewed exact Legacy history clear" }] };
    });
    mocks.nativeJobApply.mockResolvedValue({ operationId: "clear-history-operation", target: legacy, state: "finished", outcome: "verified", cancelRequested: false, steps: [{ id: "clear_history", state: "applied", reason: null, vendorCode: null }], reason: null });
    const root = await mount(connection, { kind: "legacy", jobId: target.jobId });
    button(root, "damengJobAdmin.steps").click();
    await flush();
    expect(root.textContent).toContain("SELECT 1;");
    button(root, "damengJobAdmin.schedules").click();
    await flush();
    expect(root.textContent).toContain("old_schedule");
    expect(button(root, "damengJobAdmin.clearHistories").disabled).toBe(false);
    button(root, "damengJobAdmin.clearHistories").click();
    await flush();
    expect(request).toMatchObject({ action: "clear-history", target: legacy, baseline: "baseline" });
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
    expect(root.querySelector('[data-dialog="true"]')?.textContent).toContain("reviewed exact Legacy history clear");
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(mocks.nativeJobApply).toHaveBeenCalledExactlyOnceWith("clear-history-plan");
    expect(root.textContent).toContain("nativeJobs.outcomes.verified");
  });
  it.each(["available", "denied"] as const)("edits Legacy body and next date only when their independent definition is %s", async (status) => {
    const legacy = { kind: "legacy" as const, scope, jobId: target.jobId };
    details.snapshot.ref = legacy;
    details.legacyDefinition = status === "available" ? { status, value: { WHAT: "old();", NEXT_DATE: "2032-01-02 03:04:05", NEXT_SEC: "03:04:05", INTERVAL: "86400", INSTANCE: 1 } } : { status, reason: "privilege_missing" };
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "Job_1", owner: "Owner", enabled: false, aliases: [] }] }, source: { source: "SYSJOB.SYSJOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      return { planId: "legacy-edit-plan", operationId: "legacy-edit-operation", scope, target: legacy, steps: [{ id: "legacy_definition", label: "definition", sql: "reviewed Legacy definition change" }] };
    });
    mocks.nativeJobApply.mockResolvedValue({ operationId: "legacy-edit-operation", target: legacy, state: "finished", outcome: "verified", cancelRequested: false, steps: [{ id: "legacy_definition", state: "applied", reason: null, vendorCode: null }], reason: null });
    const root = await mount(connection, { kind: "legacy", jobId: target.jobId });
    button(root, "nativeJobs.editJob").click();
    await flush();
    const body = root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.WHAT"]')!;
    const date = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.NEXT_DATE"]')!;
    expect(body.disabled).toBe(status !== "available");
    expect(date.disabled).toBe(status !== "available");
    if (status === "available") {
      input(root, "nativeJobs.definitionFields.WHAT", "BEGIN work('O''ne'); END;  ");
      input(root, "nativeJobs.definitionFields.NEXT_DATE", "2032-02-03 04:05:06");
      button(root, "damengJobAdmin.previewSql").click();
      await flush();
      expect(request).toMatchObject({
        target: legacy,
        baseline: "baseline",
        attributes: [
          { name: "WHAT", change: { kind: "set", value: "BEGIN work('O''ne'); END;  " } },
          { name: "NEXT_DATE", change: { kind: "set", value: "2032-02-03 04:05:06" } },
        ],
      });
      expect(mocks.nativeJobApply).not.toHaveBeenCalled();
      button(root, "damengJobAdmin.applySql").click();
      await flush();
      expect(mocks.nativeJobApply).toHaveBeenCalledExactlyOnceWith("legacy-edit-plan");
      expect(root.textContent).toContain("nativeJobs.outcomes.verified");
    }
  });
  it.each(["available", "denied", "empty"] as const)("keeps native Legacy properties and controls when the independent DBMS_JOB partition is %s", async (status) => {
    const legacy = { kind: "legacy" as const, scope, jobId: target.jobId };
    details.snapshot.ref = legacy;
    details.legacyDefinition = status === "available" ? { status, value: { DBX_JOB_ID: target.jobId, WHAT: "begin\n  work('多字节');\nend;  ", NEXT_DATE: "native date text", INTERVAL: "86400", INSTANCE: 2 } } : status === "denied" ? { status, reason: "privilege_missing" } : { status };
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "Job_1", owner: "Owner", enabled: false, aliases: [] }] }, source: { source: "SYSJOB.SYSJOBS", coverage: "database" }, offset: 0, limit: 100 });
    const root = await mount(connection, { kind: "legacy", jobId: target.jobId });
    button(root, "nativeJobs.attributes").click();
    await flush();
    expect(root.textContent).toContain("old description");
    expect(root.textContent).toContain("DBMS_JOB");
    expect(button(root, "damengJobAdmin.enable").disabled).toBe(false);
    expect(button(root, "damengJobAdmin.runAsync").disabled).toBe(false);
    if (status === "available") {
      expect(root.textContent).toContain("begin\n  work('多字节');\nend;  ");
      expect(root.textContent).toContain("native date text");
      expect(root.textContent).toContain("86400");
      button(root, "nativeJobs.editJob").click();
      await flush();
      expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.WHAT"]')!.disabled).toBe(false);
      expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.NEXT_DATE"]')!.disabled).toBe(true);
      expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.INSTANCE"]')!.disabled).toBe(true);
      input(root, "nativeJobs.damengInterval", "900719925474099312345");
      button(root, "damengJobAdmin.previewSql").click();
      await flush();
      expect(request).toMatchObject({ target: legacy, attributes: [{ name: "INTERVAL", change: { kind: "set", value: "900719925474099312345" } }] });
      expect(details.snapshot.definition.status === "available" && details.snapshot.definition.value).not.toHaveProperty("WHAT");
    } else {
      expect(root.textContent).toContain(status === "empty" ? "damengJobAdmin.emptyDetails" : "nativeJobs.partitionUnavailable");
    }
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it("selects exact Program and Schedule references from the shared creation editor without changing retained inline values", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobReferences.mockImplementation(async ({ kind }) => ({
      objects: { status: "available", value: [{ DBX_OWNER: 'Own.er"One', DBX_NAME: kind === "program" ? "Pro,g.One" : "Sch.ed,One" }] },
      source: { source: "SYS.ALL_SCHEDULER_PROGRAMS", coverage: "accessible" },
      offset: 0,
      limit: 100,
    }));
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "New_scheduler");
    button(root, "nativeJobs.chooseReference").click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.PROGRAM_OWNER"]')!.value).toBe('Own.er"One');
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.PROGRAM_NAME"]')!.value).toBe("Pro,g.One");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.value).toBe("BEGIN NULL; END;");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.disabled).toBe(true);
    input(root, "nativeJobs.definitionFields.PROGRAM_NAME", "");
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.value).toBe("BEGIN NULL; END;");
    input(root, "nativeJobs.definitionFields.PROGRAM_NAME", "Pro,g.One");
    await flush();
    const choices = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((element) => element.textContent === "nativeJobs.chooseReference");
    choices.at(-1)!.click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.SCHEDULE_NAME"]')!.value).toBe("Sch.ed,One");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "create", scope, definition: { kind: "scheduler", program: { owner: 'Own.er"One', name: "Pro,g.One" }, schedule: { owner: 'Own.er"One', name: "Sch.ed,One" } } });
    expect(mocks.nativeJobReferences.mock.calls.filter(([value]) => value.name === undefined).map(([value]) => value.kind)).toEqual(["program", "schedule"]);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("selects a Chain and external references without splitting names on dots or commas", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobReferences.mockImplementation(async ({ kind }) => ({
      objects: { status: "available", value: [{ DBX_OWNER: 'Own.er"One', DBX_NAME: `${kind},One` }] },
      source: { source: "catalog", coverage: "accessible" },
      offset: 0,
      limit: 100,
    }));
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "Reference_job");
    const jobType = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.definitionFields.JOB_TYPE"]')!;
    jobType.value = "CHAIN";
    jobType.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    root.querySelector('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    for (const field of ["CREDENTIAL_NAME", "DESTINATION_NAME"]) {
      const input = root.querySelector<HTMLInputElement>(`[aria-label="nativeJobs.definitionFields.${field}"]`)!;
      [...input.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
      await flush();
      root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
      await flush();
    }
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      definition: {
        jobType: "CHAIN",
        jobAction: '"Own.er""One"."chain,One"',
        credentialName: '"Own.er""One"."credential,One"',
        destinationName: '"Own.er""One"."destination,One"',
      },
    });
    expect(mocks.nativeJobReferences.mock.calls.map(([value]) => value.kind)).toEqual(["chain", "credential", "destination"]);
  });
  it("previews only activation when acknowledged Scheduler creation completed every earlier step", async () => {
    const created = { kind: "scheduler" as const, scope, owner: "Owner", name: "New_scheduler" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobRead.mockResolvedValue({ ...details, snapshot: { ...details.snapshot, ref: created, revision: "created", definition: { status: "available", value: { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN NULL; END;", ENABLED: "FALSE", NUMBER_OF_ARGUMENTS: 0, AUTO_DROP: true } } } });
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "operation",
      target: created,
      state: "finished",
      outcome: "partial",
      cancelRequested: false,
      steps: [
        { id: "create", state: "applied", reason: null, vendorCode: null },
        { id: "enable", state: "failed", reason: "native_failure", vendorCode: -1 },
      ],
      reason: "native_failure",
    });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "New_scheduler");
    const enabled = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.ENABLED"]')!;
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    button(root, "nativeJobs.correctDraft").click();
    await flush();
    expect(request).toEqual({ action: "enable", target: created, baseline: "created" });
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(1);
  });
  it("creates inline Scheduler arguments from the actual editor and keeps their count in the definition", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "New_scheduler");
    input(root, "nativeJobs.definitionFields.JOB_ACTION", "work_proc");
    const jobType = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.definitionFields.JOB_TYPE"]')!;
    jobType.value = "STORED_PROCEDURE";
    jobType.dispatchEvent(new Event("change", { bubbles: true }));
    button(root, "nativeJobs.arguments").click();
    await flush();
    button(root, "nativeJobs.addArgument").click();
    await flush();
    const state = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.argumentState"]')!;
    state.value = "value";
    state.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    input(root, "nativeJobs.argumentValue", "a,b'c");
    button(root, "nativeJobs.definition").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.NUMBER_OF_ARGUMENTS"]')?.value).toBe("1");
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')?.value).toBe("work_proc");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      action: "create",
      scope,
      definition: { kind: "scheduler", owner: "Owner", name: "New_scheduler", jobType: "STORED_PROCEDURE", jobAction: "work_proc", numberOfArguments: 1, arguments: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "a,b'c" } }] },
    });
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("loads Program defaults in the creation form, ignores stale metadata and only submits the chosen override", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    const old: Array<(value: unknown) => void> = [];
    const catalog = (kind: string, name: string) => ({
      objects: {
        status: "available",
        value:
          kind === "program"
            ? [{ DBX_OWNER: "Owner", DBX_NAME: name, PROGRAM_TYPE: "STORED_PROCEDURE", PROGRAM_ACTION: "program_procedure", NUMBER_OF_ARGUMENTS: 2 }]
            : [
                { DBX_OWNER: "Owner", DBX_NAME: name, ARGUMENT_POSITION: 1, ARGUMENT_NAME: "TEXT", ARGUMENT_TYPE: "VARCHAR2", DEFAULT_VALUE: `${name} native default`, OUT_ARGUMENT: "FALSE" },
                { DBX_OWNER: "Owner", DBX_NAME: name, ARGUMENT_POSITION: 2, ARGUMENT_NAME: "OPTIONAL", ARGUMENT_TYPE: "NUMBER", DEFAULT_VALUE: null, OUT_ARGUMENT: "FALSE" },
              ],
      },
      source: { source: "SYS.ALL_SCHEDULER_PROGRAMS", coverage: "accessible" },
      offset: 0,
      limit: 100,
    });
    mocks.nativeJobReferences.mockImplementation(({ kind, name }) =>
      name === "Old.Program"
        ? new Promise((resolve) => {
            old.push((value) => resolve(value));
          })
        : Promise.resolve(catalog(kind, name)),
    );
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "Program_job");
    input(root, "nativeJobs.definitionFields.PROGRAM_NAME", "Old.Program");
    await flush();
    input(root, "nativeJobs.definitionFields.PROGRAM_NAME", "New.Program");
    await flush();
    old.forEach((resolve, index) => resolve(catalog(index === 0 ? "program" : "program-arguments", "Old.Program")));
    await flush();
    button(root, "nativeJobs.arguments").click();
    await flush();
    const defaults = [...root.querySelectorAll<HTMLTextAreaElement>('[aria-label="nativeJobs.programDefault"]')];
    expect(defaults.map((field) => field.value)).toContain("New.Program native default");
    expect(defaults.map((field) => field.value)).not.toContain("Old.Program native default");
    expect(defaults.every((field) => field.readOnly)).toBe(true);
    expect(root.textContent).toContain("nativeJobs.programDefaultUnknown");
    const states = root.querySelectorAll<HTMLSelectElement>('[aria-label="nativeJobs.argumentState"]');
    expect(states).toHaveLength(2);
    expect(states[0]!.value).toBe("inherit");
    states[0]!.value = "value";
    states[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    input(root, "nativeJobs.argumentValue", "chosen override");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "create", definition: { program: { owner: "Owner", name: "New.Program" }, arguments: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "chosen override" } }] } });
  });
  it("shows Program defaults separately and preserves unmodified overrides and database-supplied arguments", async () => {
    const ref = { kind: "scheduler" as const, scope, owner: "Owner", name: "Program_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref, name: ref.name, owner: ref.owner, enabled: false, jobType: "STORED_PROCEDURE", state: "DISABLED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = ref;
    details.snapshot.definition = { status: "available", value: { PROGRAM_OWNER: "Shared.Owner", PROGRAM_NAME: "Program,One", NUMBER_OF_ARGUMENTS: null, JOB_TYPE: null, JOB_ACTION: null, COMMENTS: "unchanged" } };
    details.program = { status: "available", value: { PROGRAM_TYPE: "STORED_PROCEDURE", PROGRAM_ACTION: "original_program_procedure", NUMBER_OF_ARGUMENTS: 3 } };
    details.snapshot.arguments = {
      status: "available",
      value: [
        { position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "keep override" }, defaultValue: { status: "available", value: { kind: "value", value: "original default" } }, editable: true },
        { position: 2, dataType: "VARCHAR2", value: { kind: "inherit" }, defaultValue: { status: "unknown", reason: "native_job_program_default_ambiguous" }, editable: true },
        { position: 3, dataType: "VARCHAR2", value: { kind: "inherit" }, metadataAttribute: "JOB_NAME", editable: false },
      ],
    };
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.NUMBER_OF_ARGUMENTS"]')!.disabled).toBe(true);
    expect(root.textContent).toContain("original_program_procedure");
    button(root, "nativeJobs.arguments").click();
    await flush();
    const originalDefault = root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.programDefault"]')!;
    expect(originalDefault.value).toBe("original default");
    expect(originalDefault.readOnly).toBe(true);
    expect(root.textContent).toContain("nativeJobs.programDefaultUnknown");
    expect(root.textContent).toContain("nativeJobs.metadataArgument");
    const states = root.querySelectorAll<HTMLSelectElement>('[aria-label="nativeJobs.argumentState"]');
    expect(states[2]!.disabled).toBe(true);
    states[1]!.value = "value";
    states[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const fields = root.querySelectorAll<HTMLTextAreaElement>('[aria-label="nativeJobs.argumentValue"]');
    expect(fields[0]!.value).toBe("keep override");
    fields[1]!.value = "only changed argument";
    fields[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: ref, attributes: [], arguments: [{ position: 2, value: { kind: "value", value: "only changed argument" } }] });
    expect(details.snapshot.arguments.value[0]!.value).toEqual({ kind: "value", value: "keep override" });
  });
  it("uses the existing edit picker for a new Program without migrating old-position or opaque overrides", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Program_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "STORED_PROCEDURE", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = { status: "available", value: { ENABLED: true, PROGRAM_OWNER: "Owner", PROGRAM_NAME: "Old.Program", JOB_TYPE: null, JOB_ACTION: null, NUMBER_OF_ARGUMENTS: null, SCHEDULE_OWNER: null, SCHEDULE_NAME: null } };
    details.snapshot.arguments = {
      status: "available",
      value: [
        { position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "old private override" }, editable: true },
        { position: 2, dataType: "OBJECT", value: { kind: "opaque", value: { object: "old" } }, editable: false },
      ],
    };
    const program = { owner: 'Other.Owner"', name: "New,Program.One" };
    mocks.nativeJobReferences.mockImplementation(async ({ kind, schema, name }) => ({
      objects: {
        status: "available",
        value:
          kind === "program-arguments"
            ? [
                { DBX_OWNER: schema, DBX_NAME: name, ARGUMENT_POSITION: 1, ARGUMENT_TYPE: "VARCHAR2", DEFAULT_VALUE: "target default", OUT_ARGUMENT: false },
                { DBX_OWNER: schema, DBX_NAME: name, ARGUMENT_POSITION: 2, ARGUMENT_TYPE: "NUMBER", DEFAULT_VALUE: null, OUT_ARGUMENT: false },
              ]
            : [{ DBX_OWNER: program.owner, DBX_NAME: program.name, PROGRAM_TYPE: "STORED_PROCEDURE", PROGRAM_ACTION: "target_proc", NUMBER_OF_ARGUMENTS: 2 }],
      },
      source: { source: "SYS.ALL_SCHEDULER_PROGRAMS", coverage: "accessible" },
      offset: 0,
      limit: 100,
    }));
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.PROGRAM_NAME"]')!.disabled).toBe(false);
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.PROGRAM_NAME"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    button(root, "nativeJobs.arguments").click();
    await flush();
    expect([...root.querySelectorAll<HTMLTextAreaElement>('[aria-label="nativeJobs.programDefault"]')].map((field) => field.value)).toContain("target default");
    expect([...root.querySelectorAll<HTMLTextAreaElement>('[aria-label="nativeJobs.argumentValue"]')].map((field) => field.value)).not.toContain("old private override");
    const state = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.argumentState"]')!;
    expect(state.value).toBe("inherit");
    state.value = "value";
    state.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    input(root, "nativeJobs.argumentValue", "new target value");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      action: "update",
      target: scheduler,
      finalEnabled: true,
      attributes: [{ name: "PROGRAM_NAME", change: { kind: "set", value: program } }],
      arguments: [],
      argumentTarget: {
        program,
        arguments: [
          { position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "new target value" } },
          { position: 2, dataType: "NUMBER", value: { kind: "inherit" } },
        ],
      },
    });
    expect(details.snapshot.arguments.value[0]!.value).toEqual({ kind: "value", value: "old private override" });
  });
  it("selects a typed Window group and captures a disabled final state without writing ENABLED as an attribute", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Calendar_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "PLSQL_BLOCK", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = {
      status: "available",
      value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN NULL; END;", NUMBER_OF_ARGUMENTS: 0, SCHEDULE_OWNER: null, SCHEDULE_NAME: null, SCHEDULE_TYPE: "CALENDAR", START_DATE: "2030-01-01T00:00:00+08:00", REPEAT_INTERVAL: "FREQ=DAILY" },
    };
    mocks.nativeJobReferences.mockResolvedValue({ objects: { status: "available", value: [{ DBX_OWNER: "SYS", DBX_NAME: "Night,Group.One", GROUP_TYPE: "WINDOW" }] }, source: { source: "SYS.ALL_SCHEDULER_GROUPS", coverage: "accessible" }, offset: 0, limit: 100 });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    const kind = root.querySelector<HTMLSelectElement>('select[aria-label="nativeJobs.chooseReference"]')!;
    kind.value = "window-group";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const enabled = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.ENABLED"]')!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.SCHEDULE_NAME"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    expect(mocks.nativeJobReferences).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "window-group" }));
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.inactiveInlineDraft");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.START_DATE"]')!.disabled).toBe(true);
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", finalEnabled: false, attributes: [{ name: "SCHEDULE_NAME", change: { kind: "set", value: { owner: "SYS", name: "Night,Group.One", kind: "window-group" } } }], arguments: [] });
    expect(request).not.toHaveProperty("argumentTarget");
  });
  it("edits a queue event in the original dialog without copying inactive calendar fields or dispatching apply", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Event_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "PLSQL_BLOCK", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = {
      status: "available",
      value: {
        ENABLED: true,
        PROGRAM_OWNER: null,
        PROGRAM_NAME: null,
        JOB_TYPE: "PLSQL_BLOCK",
        JOB_ACTION: "BEGIN NULL; END;",
        NUMBER_OF_ARGUMENTS: 0,
        SCHEDULE_OWNER: "Calendar.Owner",
        SCHEDULE_NAME: "Named",
        SCHEDULE_TYPE: "NAMED",
        START_DATE: null,
        END_DATE: null,
        REPEAT_INTERVAL: null,
        EVENT_CONDITION: null,
        EVENT_QUEUE_OWNER: null,
        EVENT_QUEUE_NAME: null,
        FILE_WATCHER_OWNER: null,
        FILE_WATCHER_NAME: null,
      },
    };
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    const mode = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.scheduleMode"]')!;
    mode.value = "queue";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    input(root, "nativeJobs.eventQueueOwner", "Queue.Owner");
    input(root, "nativeJobs.eventQueueName", 'Q,One"');
    input(root, "nativeJobs.eventQueueAgent", "Agent.Exact");
    input(root, "nativeJobs.eventCondition", "tab.user_data.ready = 'Y'");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      finalEnabled: true,
      attributes: [
        { name: "SCHEDULE_NAME", change: { kind: "clear" } },
        { name: "EVENT_SPEC", change: { kind: "set", value: { condition: "tab.user_data.ready = 'Y'", source: { kind: "queue", owner: "Queue.Owner", name: 'Q,One"', agent: "Agent.Exact" } } } },
      ],
    });
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it("keeps host and named destination drafts separate and previews only the selected native slot", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Host_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "STORED_PROCEDURE", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = { status: "available", value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "proc", NUMBER_OF_ARGUMENTS: 0, DESTINATION_OWNER: null, DESTINATION: "host.with.dots:1500" } };
    mocks.nativeJobReferences.mockResolvedValue({ objects: { status: "available", value: [{ DBX_OWNER: "Dest.Owner", DBX_NAME: "Named,Dest" }] }, source: { source: "SYS.ALL_SCHEDULER_DB_DESTS", coverage: "accessible" }, offset: 0, limit: 100 });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.DESTINATION"]')!.value).toBe("host.with.dots:1500");
    expect(root.querySelector('[aria-label="nativeJobs.definitionFields.DESTINATION_NAME"]')).toBeNull();
    input(root, "nativeJobs.definitionFields.DESTINATION", "Retained.Host:1501");
    const mode = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.destinationMode"]')!;
    mode.value = "named";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const field = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.DESTINATION_NAME"]')!.parentElement!;
    [...field.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("nativeJobs.chooseReference") && !button.textContent?.includes("destinationGroup"))!.click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    mode.value = "legacy";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.DESTINATION"]')!.value).toBe("Retained.Host:1501");
    mode.value = "named";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", attributes: [{ name: "DESTINATION_NAME", change: { kind: "set", value: { owner: "Dest.Owner", name: "Named,Dest" } } }] });
    expect(request?.action === "update" && request.attributes.some(({ name }) => name === "DESTINATION")).toBe(false);
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it.each(["set", "clear"] as const)("previews a raw host %s through DESTINATION without applying it", async (change) => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Host_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, aliases: [] }] }, source: { coverage: "database" }, offset: 0, limit: 100 });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = { status: "available", value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "proc", NUMBER_OF_ARGUMENTS: 0, DESTINATION_OWNER: null, DESTINATION: "host.with.dots:1500" } };
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    if (change === "set") input(root, "nativeJobs.definitionFields.DESTINATION", "Exact.Host:1600");
    else {
      const field = root.querySelector('[aria-label="nativeJobs.definitionFields.DESTINATION"]')!.parentElement!;
      [...field.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "NULL")!.click();
      await flush();
      expect(root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.destinationMode"]')!.value).toBe("local");
    }
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", finalEnabled: true, attributes: [{ name: "DESTINATION", change: change === "set" ? { kind: "set", value: "Exact.Host:1600" } : { kind: "clear" } }] });
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it("restores original inline values only to the draft and still requires a new preview", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Restore_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "STORED_PROCEDURE", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = { status: "available", value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "original_proc", NUMBER_OF_ARGUMENTS: 1, SCHEDULE_OWNER: null, SCHEDULE_NAME: null } };
    details.snapshot.arguments = { status: "available", value: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "original input" }, editable: true }] };
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.definitionFields.JOB_ACTION", "target_proc");
    input(root, "nativeJobs.definitionFields.NUMBER_OF_ARGUMENTS", "2");
    await flush();
    button(root, "nativeJobs.restoreDefinitionDraft").click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.value).toBe("original_proc");
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.NUMBER_OF_ARGUMENTS"]')!.value).toBe("1");
    expect(root.textContent).not.toContain("nativeJobs.explicitNull");
    expect(mocks.nativeJobPrepare).not.toHaveBeenCalled();
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ finalEnabled: true, attributes: [], argumentTarget: { program: null, arguments: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "original input" } }] } });
  });
  it("creates a file arrival trigger through the existing File watcher picker", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobReferences.mockResolvedValue({ objects: { status: "available", value: [{ DBX_OWNER: 'File.Owner"', DBX_NAME: "Arrival,One" }] }, source: { source: "SYS.ALL_SCHEDULER_FILE_WATCHERS", coverage: "accessible" }, offset: 0, limit: 100 });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "File_job");
    const mode = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.scheduleMode"]')!;
    mode.value = "file-watcher";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    [...root.querySelector('[aria-label="nativeJobs.fileWatcherName"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    expect(mocks.nativeJobReferences).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "file-watcher", scope }));
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.fileWatcherOwner"]')!.value).toBe('File.Owner"');
    input(root, "nativeJobs.eventCondition", "tab.user_data.file_size > 0");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "create", definition: { kind: "scheduler", eventCondition: "tab.user_data.file_size > 0", eventSource: { kind: "file-watcher", reference: { owner: 'File.Owner"', name: "Arrival,One" } } } });
    if (request?.action === "create") expect(request.definition).not.toHaveProperty("repeatInterval");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("reuses the existing reference pickers and retains the edit when Core rejects a Chain destination group", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Chain_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "CHAIN", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = {
      status: "available",
      value: {
        ENABLED: true,
        PROGRAM_OWNER: null,
        PROGRAM_NAME: null,
        JOB_TYPE: "CHAIN",
        JOB_ACTION: '"Owner"."Old_chain"',
        NUMBER_OF_ARGUMENTS: 0,
        CONNECT_CREDENTIAL_OWNER: "Credentials.Owner",
        CONNECT_CREDENTIAL_NAME: "Old.Login",
        CREDENTIAL_OWNER: null,
        CREDENTIAL_NAME: null,
        DESTINATION_OWNER: null,
        DESTINATION: null,
      },
    };
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      if (value.action === "update" && value.attributes.some((attribute) => attribute.name === "DESTINATION_NAME" && attribute.change.kind === "set" && typeof attribute.change.value === "object" && !Array.isArray(attribute.change.value) && attribute.change.value?.kind === "destination-group"))
        throw new Error("native_job_reference_not_applicable");
      return { planId: "corrected-plan", operationId: "corrected-operation", scope, target: scheduler, steps: [{ id: "attributes", label: "native_job_step_attributes", sql: "reviewed remaining definition" }] };
    });
    mocks.nativeJobReferences.mockImplementation(async ({ kind }) => ({
      objects: { status: "available", value: [{ DBX_OWNER: 'Other.Owner"', DBX_NAME: kind === "chain" ? "Chain,New" : kind === "credential" ? "Login,New" : "Group,New", ...(kind === "destination-group" ? { GROUP_TYPE: "DB_DEST" } : {}) }] },
      source: { source: "SYS.ALL_SCHEDULER_GROUPS", coverage: "accessible" },
      offset: 0,
      limit: 100,
    }));
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    expect(mocks.nativeJobReferences).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "chain" }));
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.CONNECT_CREDENTIAL_NAME"]')!.value).toBe('"Credentials.Owner"."Old.Login"');
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.CONNECT_CREDENTIAL_NAME"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    const destinationMode = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.destinationMode"]')!;
    destinationMode.value = "named";
    destinationMode.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.DESTINATION_NAME"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click();
    await flush();
    expect(mocks.nativeJobReferences).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "destination-group" }));
    root.querySelector<HTMLButtonElement>("[data-native-reference]")!.click();
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      finalEnabled: true,
      attributes: [
        { name: "JOB_ACTION", change: { kind: "set", value: '"Other.Owner"""."Chain,New"' } },
        { name: "CONNECT_CREDENTIAL_NAME", change: { kind: "set", value: { owner: 'Other.Owner"', name: "Login,New" } } },
        { name: "DESTINATION_NAME", change: { kind: "set", value: { owner: 'Other.Owner"', name: "Group,New", kind: "destination-group" } } },
      ],
    });
    expect(root.textContent).toContain("native_job_reference_not_applicable");
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
    [...root.querySelector('[aria-label="nativeJobs.definitionFields.DESTINATION_NAME"]')!.parentElement!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "NULL")!.click();
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request?.action === "update" && request.attributes.some((attribute) => attribute.name === "DESTINATION_NAME")).toBe(false);
    expect(mocks.nativeJobPrepare).toHaveBeenCalledTimes(2);
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it("retains a complete inline parameter target and original activation intent after a partial count conversion", async () => {
    const scheduler = { kind: "scheduler" as const, scope, owner: "Owner", name: "Inline_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: scheduler, name: scheduler.name, owner: "Owner", enabled: true, jobType: "STORED_PROCEDURE", state: "SCHEDULED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null }] },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    details.snapshot.ref = scheduler;
    details.snapshot.definition = { status: "available", value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "inline_proc", NUMBER_OF_ARGUMENTS: 1 } };
    details.snapshot.arguments = { status: "available", value: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "original override" }, editable: true }] };
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      return { planId: "immutable-plan", operationId: "operation", scope, target: scheduler, steps: [{ id: "attributes", label: "native_job_step_attributes", sql: "reviewed definition" }] };
    });
    const root = await mount({ ...connection, db_type: "oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.definitionFields.NUMBER_OF_ARGUMENTS", "2");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    const complete = structuredClone(request);
    expect(complete).toMatchObject({
      finalEnabled: true,
      argumentTarget: {
        program: null,
        arguments: [
          { position: 1, value: { kind: "value", value: "original override" } },
          { position: 2, value: { kind: "unset" } },
        ],
      },
    });
    details.snapshot.revision = "after";
    details.snapshot.definition.value.ENABLED = false;
    details.snapshot.definition.value.NUMBER_OF_ARGUMENTS = 2;
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "operation",
      target: scheduler,
      state: "finished",
      outcome: "partial",
      cancelRequested: false,
      steps: [
        { id: "attributes", state: "applied", reason: null, vendorCode: null },
        { id: "argument:2", state: "failed", reason: "native_failure", vendorCode: 1 },
      ],
      reason: "native_failure",
    });
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    button(root, "nativeJobs.correctDraft").click();
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ baseline: "after", finalEnabled: true, attributes: [], argumentTarget: complete && "argumentTarget" in complete ? complete.argumentTarget : undefined });
  });
  it("creates and edits Oracle traditional jobs in the shared page without exposing a session-kill stop", async () => {
    const legacy = { kind: "legacy" as const, scope, jobId: "900719925474099312345" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [{ ref: legacy, name: legacy.jobId, owner: null, enabled: false, jobType: "legacy", state: "BROKEN", nextRun: null, comments: null, aliases: [], logUser: "Log", privUser: "Privilege", schemaUser: "Owner" }] },
      source: { source: "SYS.DBA_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    mocks.nativeJobRead.mockResolvedValue({ ...details, snapshot: { ...details.snapshot, ref: legacy, definition: { status: "available", value: { WHAT: "old();", NEXT_DATE: "2026-10-21 10:00:00", INTERVAL: "NULL", INSTANCE: 0, LOG_USER: "Log", PRIV_USER: "Privilege", SCHEMA_USER: "Owner" } } } });
    const root = await mount({ ...connection, db_type: "oracle", database: "SERVICE" }, { kind: "legacy", jobId: legacy.jobId });
    expect(mocks.nativeJobList).toHaveBeenLastCalledWith({ scope, kind: "legacy", filter: "", offset: 0, limit: 100 });
    expect(root.textContent).toContain("nativeJobs.legacyNoStop");
    expect(root.textContent).toContain("nativeJobs.runForeground");
    expect(root.textContent).not.toContain("damengJobAdmin.stopRunning");
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.definitionFields.WHAT", "corrected();");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: legacy, attributes: [{ name: "WHAT", change: { kind: "set", value: "corrected();" } }] });
    button(root, "common.cancel").click();
    await flush();
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    expect(root.querySelector('[aria-label="damengJobAdmin.jobName"]')).toBeNull();
    input(root, "nativeJobs.definitionFields.WHAT", "new_work();");
    input(root, "nativeJobs.definitionFields.NEXT_DATE", "2026-10-21 12:00:00");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "create", scope, definition: { kind: "legacy", what: "new_work();", nextDate: "2026-10-21 12:00:00", enabled: false, schema: "Owner", instance: 0 } });
    expect(request).not.toHaveProperty("target");
  });
  it("keeps OB base attributes read-only while editing its effective duration and Zone", async () => {
    const ref = { kind: "scheduler" as const, scope, owner: "Owner", name: "OB_job" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oceanbase-oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "4.2.5.7" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref, name: ref.name, owner: ref.owner, enabled: false, aliases: [] }] }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    details.snapshot.ref = ref;
    details.snapshot.definition = { status: "available", value: { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN kept(); END;", COMMENTS: "keep", AUTO_DROP: false, MAX_FAILURES: 2, MAX_RUN_DURATION: "+000 00:02:00", INSTANCE_ID: "RANDOM" } };
    const root = await mount({ ...connection, db_type: "oceanbase-oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.COMMENTS"]')!.disabled).toBe(true);
    expect(root.textContent).toContain("nativeJobs.obSchedulerDefinitionReadOnly");
    button(root, "nativeJobs.advanced").click();
    await flush();
    const zone = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.ZONE"]')!;
    expect(zone.type).toBe("text");
    expect(zone.value).toBe("RANDOM");
    expect(zone.disabled).toBe(false);
    input(root, "nativeJobs.definitionFields.ZONE", "zone1");
    input(root, "nativeJobs.definitionFields.MAX_RUN_DURATION", "0 00:03:00");
    expect(root.querySelector('[aria-label="nativeJobs.definitionFields.JOB_PRIORITY"]')).toBeNull();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      action: "update",
      attributes: [
        { name: "INSTANCE_ID", change: { kind: "set", value: "zone1" } },
        { name: "MAX_RUN_DURATION", change: { kind: "set", value: "0 00:03:00" } },
      ],
    });
  });
  it("edits and clears the OB Legacy Zone from raw INSTANCE without changing the native snapshot", async () => {
    const legacy = { kind: "legacy" as const, scope, jobId: "41" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oceanbase-oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "4.2.5.7" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "41", owner: null, enabled: false, aliases: [] }] }, source: { source: "SYS.USER_JOBS", coverage: "current_user" }, offset: 0, limit: 100 });
    details.snapshot.ref = legacy;
    details.snapshot.definition = { status: "available", value: { WHAT: "old();", NEXT_DATE: "2026-10-21 10:00:00", INTERVAL: "SYSDATE+1", INSTANCE: "zone1", LOG_USER: "Owner", PRIV_USER: "Owner", SCHEMA_USER: "Owner" } };
    const root = await mount({ ...connection, db_type: "oceanbase-oracle" }, legacy);
    button(root, "nativeJobs.editJob").click();
    await flush();
    const zone = root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.ZONE"]')!;
    expect(zone.value).toBe("zone1");
    expect(zone.disabled).toBe(false);
    expect(zone.type).toBe("text");
    input(root, "nativeJobs.definitionFields.ZONE", "zone2");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: legacy, attributes: [{ name: "ZONE", change: { kind: "set", value: "zone2" } }] });
    button(root, "common.cancel").click();
    await flush();
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "NULL").click();
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", attributes: [{ name: "ZONE", change: { kind: "clear" } }] });
    expect(details.snapshot.definition.value.INSTANCE).toBe("zone1");
    expect(details.snapshot.definition.value).not.toHaveProperty("ZONE");
  });
  it("previews the OB Legacy foreground run and its native restoration of future scheduling", async () => {
    const legacy = { kind: "legacy" as const, scope, jobId: "41" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oceanbase-oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "4.2.5.7" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "available", value: [{ ref: legacy, name: "41", owner: null, enabled: false, aliases: [] }] }, source: { source: "SYS.USER_JOBS", coverage: "current_user" }, offset: 0, limit: 100 });
    details.snapshot.ref = legacy;
    mocks.nativeJobPrepare.mockImplementation(async (value: NativeJobRequest) => {
      request = value;
      return { planId: "plan", operationId: "operation", scope, target: legacy, steps: [{ id: "run", label: "native_job_step_run", sql: "BEGIN SYS.DBMS_JOB.RUN(41); END;" }] };
    });
    const root = await mount({ ...connection, db_type: "oceanbase-oracle" }, legacy);
    button(root, "nativeJobs.runForeground").click();
    await flush();
    expect(request).toMatchObject({ action: "run", target: legacy });
    expect(root.textContent).toContain("nativeJobs.legacyRunRestoresScheduling");
    expect(mocks.nativeJobApply).not.toHaveBeenCalled();
  });
  it("offers only OB native creation types while keeping initial definition inputs writable", async () => {
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oceanbase-oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "4.2.5.7" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    const root = await mount({ ...connection, db_type: "oceanbase-oracle" });
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    const type = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.definitionFields.JOB_TYPE"]')!;
    expect([...type.options].map((option) => option.value)).toEqual(["PLSQL_BLOCK", "STORED_PROCEDURE"]);
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.definitionFields.JOB_ACTION"]')!.disabled).toBe(false);
    expect(root.querySelector('[aria-label="nativeJobs.definitionFields.SCHEDULE_NAME"]')).toBeNull();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector('[aria-label="nativeJobs.definitionFields.CREDENTIAL_NAME"]')).toBeNull();
    expect(root.querySelector('[aria-label="nativeJobs.definitionFields.DESTINATION_NAME"]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.ZONE"]')!.disabled).toBe(false);
  });
  it("retains different-owner drafts when switching jobs and keeps denied arguments separate from readable definition fields", async () => {
    const first = { kind: "scheduler" as const, scope, owner: "One", name: "Same" };
    const second = { ...first, owner: "Two" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oceanbase-oracle", sessionUser: "One", actualDatabase: "DB", productVersion: "4.2.5.7" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [first, second].map((ref) => ({ ref, name: ref.name, owner: ref.owner, enabled: false, jobType: "PLSQL_BLOCK", state: null, nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null })) },
      source: { source: "SYS.ALL_SCHEDULER_JOBS", coverage: "accessible" },
      offset: 0,
      limit: 100,
    });
    mocks.nativeJobRead.mockImplementation(async (ref) => ({
      ...details,
      snapshot: { ...details.snapshot, ref, definition: { status: "available", value: { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN old(); END;", MAX_RUN_DURATION: "+000 00:00:00" } }, arguments: { status: "denied", reason: "privilege_missing" } },
    }));
    const root = await mount({ ...connection, db_type: "oceanbase-oracle" });
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    input(root, "nativeJobs.definitionFields.MAX_RUN_DURATION", "0 00:02:00");
    button(root, "common.cancel").click();
    await flush();
    [...root.querySelectorAll("button")].find((element) => element.textContent?.includes("Same") && element.textContent.includes("Two"))!.click();
    await flush();
    [...root.querySelectorAll("button")].find((element) => element.textContent?.includes("Same") && element.textContent.includes("One"))!.click();
    await flush();
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.advanced").click();
    await flush();
    expect(root.querySelector<HTMLInputElement>('[aria-label="nativeJobs.definitionFields.MAX_RUN_DURATION"]')?.value).toBe("0 00:02:00");
    button(root, "nativeJobs.arguments").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.partitionUnavailable");
    button(root, "nativeJobs.definition").click();
    await flush();
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: first, attributes: [{ name: "MAX_RUN_DURATION", change: { kind: "set", value: "0 00:02:00" } }], arguments: [] });
    expect(root.textContent).not.toContain("nativeJobs.forceStop");
  });
  it("rebinds an explicit native selection outside the current list page to the new authenticated context", async () => {
    const selected = { kind: "scheduler" as const, owner: "Exact.Owner", name: "Outside.Page" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "empty" }, source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" }, offset: 0, limit: 100 });
    mocks.nativeJobRead.mockImplementation(async (ref) => ({ ...details, snapshot: { ...details.snapshot, ref, definition: { status: "available", value: { JOB_ACTION: "retained();", ENABLED: false } } } }));
    const root = await mount({ ...connection, db_type: "oracle" }, selected);
    expect(mocks.nativeJobRead).toHaveBeenLastCalledWith({ ...selected, scope });
    expect(root.textContent).toContain("Outside.Page");
    expect(mocks.track.mock.calls[0]![0]()).toMatchObject({ selectedJob: selected, kind: "scheduler" });
  });
  it("uses the shared native page for Oracle and preserves exact owners when two Scheduler jobs have the same name", async () => {
    const first = { kind: "scheduler" as const, scope, owner: "Owner.One", name: "Same,Job" };
    const second = { ...first, owner: "Owner.Two" };
    mocks.nativeJobOpenContext.mockResolvedValue({ scope, engine: "oracle", sessionUser: "Owner.One", actualDatabase: "DB", productVersion: "19" });
    mocks.nativeJobList.mockResolvedValue({
      jobs: { status: "available", value: [first, second].map((ref) => ({ ref, name: ref.name, owner: ref.owner, enabled: false, jobType: "PLSQL_BLOCK", state: "DISABLED", nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null })) },
      source: { source: "SYS.DBA_SCHEDULER_JOBS", coverage: "database" },
      offset: 0,
      limit: 100,
    });
    mocks.nativeJobRead.mockImplementation(async (ref) => ({ ...structuredClone(details), snapshot: { ...details.snapshot, ref, definition: { status: "available", value: { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN old(); END;", COMMENTS: "keep", AUTO_DROP: false, NUMBER_OF_ARGUMENTS: 0 } } } }));
    const root = await mount({ ...connection, db_type: "oracle" });
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.nativeJobOpenContext).toHaveBeenCalledWith("c", "");
    const selected = [...root.querySelectorAll("button")].find((element) => element.textContent?.includes("Same,Job") && element.textContent.includes("Owner.Two"))!;
    expect(selected).toBeDefined();
    selected.click();
    await flush();
    expect(mocks.nativeJobRead).toHaveBeenLastCalledWith(second);
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.definitionFields.JOB_ACTION", "BEGIN corrected(); END;");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "update", target: second, attributes: [{ name: "JOB_ACTION", change: { kind: "set", value: "BEGIN corrected(); END;" } }] });
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
  it("searches the backend beyond the loaded page and persists the actual page offset", async () => {
    vi.useFakeTimers();
    const root = await mount();
    expect(mocks.track.mock.calls[0]![0]()).toMatchObject({ listOffset: 0 });
    const search = root.querySelector<HTMLInputElement>('[placeholder="damengJobAdmin.searchJob"]')!;
    search.value = "Owner's description";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(mocks.nativeJobList).toHaveBeenLastCalledWith({ scope, kind: "dameng-native", filter: "Owner's description", offset: 0, limit: 100 });
    expect(button(root, "nativeJobs.nextPage").disabled).toBe(true);
  });
  it("keeps the existing new-job entry but prepares a disabled-first native creation instead of executing editor SQL", async () => {
    const root = await mount();
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "New_job");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ action: "create", scope, definition: { kind: "dameng-native", name: "New_job", enabled: true, configuration: { steps: [{ kind: "add", name: "STEP1" }], schedules: [{ kind: "add", name: "SCHEDULE1" }] } } });
    expect(request).not.toHaveProperty("target");
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(mocks.nativeJobApply).toHaveBeenCalledExactlyOnceWith("immutable-plan");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("continues a partially created job outside the loaded page using its acknowledged child IDs instead of creating it again", async () => {
    const original = structuredClone(details);
    const created = { ...target, name: "New_job", jobId: "900719925474099312346" };
    const createdDetails = structuredClone(details);
    createdDetails.snapshot.ref = created;
    createdDetails.snapshot.revision = "created-baseline";
    if (createdDetails.snapshot.definition.status === "available") {
      createdDetails.snapshot.definition.value.NAME = "New_job";
      createdDetails.snapshot.definition.value.ID = created.jobId;
    }
    createdDetails.steps = { status: "available", value: [{ ID: "100", JOBID: created.jobId, NAME: "STEP1", TYPE: 0, COMMAND: "SELECT 1;", RETRY_INTERVAL: 0 }] };
    mocks.nativeJobRead.mockImplementation(async (ref) => structuredClone(ref.jobId === created.jobId ? createdDetails : original));
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "operation",
      target: created,
      state: "finished",
      outcome: "partial",
      cancelRequested: false,
      steps: [
        { id: "create", state: "applied", reason: null, vendorCode: null },
        { id: "steps:add:0", state: "applied", reason: null, vendorCode: null },
        { id: "config_commit", state: "failed", reason: "native_failure", vendorCode: -1 },
      ],
      reason: "native_failure",
      createdChildren: [{ partition: "steps", name: "STEP1", id: "100" }],
    });
    const root = await mount();
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    input(root, "damengJobAdmin.jobName", "New_job");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.outcomes.partial");
    expect(root.textContent).toContain("New_job");
    button(root, "nativeJobs.correctDraft").click();
    await flush();
    button(root, "nativeJobs.steps").click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.fields.COMMAND_INPUT"]')?.value).toBe("SELECT 1;");
    input(root, "nativeJobs.fields.RETRY_INTERVAL", "4");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      action: "configure-dameng",
      target: created,
      baseline: "created-baseline",
      configuration: { steps: [{ kind: "update", name: "STEP1", attributes: [{ name: "RETRY_INTERVAL", change: { kind: "set", value: 4 } }] }], schedules: [{ kind: "add", name: "SCHEDULE1" }] },
    });
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("creates multiple native steps with a forward dependency and preserves the first input when switching steps", async () => {
    const root = await mount();
    button(root, "damengJobAdmin.newJob").click();
    await flush();
    button(root, "nativeJobs.steps").click();
    await flush();
    input(root, "nativeJobs.fields.COMMAND_INPUT", "BEGIN report(); END;");
    button(root, "nativeJobs.add").click();
    await flush();
    input(root, "nativeJobs.fields.NAME", "STATS");
    const type = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.fields.TYPE"]')!;
    type.value = "3";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    const selection = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.steps"]')!;
    selection.value = "0";
    selection.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.fields.COMMAND_INPUT"]')?.value).toBe("BEGIN report(); END;");
    const action = root.querySelector<HTMLSelectElement>('[aria-label="nativeJobs.fields.SUCC_ACTION"]')!;
    action.value = "3";
    action.dispatchEvent(new Event("change", { bubbles: true }));
    input(root, "nativeJobs.fields.SUCC_NEXT_STEP", "STATS");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({
      action: "create",
      definition: {
        configuration: {
          steps: [
            {
              kind: "add",
              name: "STEP1",
              attributes: expect.arrayContaining([
                { name: "COMMAND_INPUT", change: { kind: "set", value: "BEGIN report(); END;" } },
                { name: "SUCC_NEXT_STEP", change: { kind: "set", value: "STATS" } },
              ]),
            },
            { kind: "add", name: "STATS", attributes: [{ name: "TYPE", change: { kind: "set", value: 3 } }] },
          ],
        },
      },
    });
  });

  it("does not disguise a denied list as an empty list", async () => {
    mocks.nativeJobList.mockResolvedValue({ jobs: { status: "denied", reason: "privilege_missing" }, source: { source: "SYSJOB.USER_JOBS_VIEW", coverage: "current_user" }, offset: 0, limit: 100 });
    const root = await mount();
    expect(root.textContent).toContain("nativeJobs.partitionUnavailable");
    expect(root.textContent).not.toContain("nativeJobs.emptyJobs");
    expect(root.textContent).not.toContain("damengJobAdmin.emptyJobs");
    expect(mocks.nativeJobRead).not.toHaveBeenCalled();
  });
  it("loads exact native details and sends a same-page edit through immutable prepare/apply instead of editor SQL", async () => {
    const root = await mount();
    expect(mocks.nativeJobRead).toHaveBeenCalledWith(target);
    expect(root.textContent).toContain("SELECT 1;");
    button(root, "nativeJobs.editJob").click();
    await flush();
    input(root, "nativeJobs.fields.DESCRIBE", "new description");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toEqual({ action: "configure-dameng", target, baseline: "baseline", configuration: { attributes: [{ name: "DESCRIBE", change: { kind: "set", value: "new description" } }], steps: [], schedules: [] } });
    expect(root.textContent).toContain("native reviewed SQL");
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(mocks.nativeJobApply).toHaveBeenCalledExactlyOnceWith("immutable-plan");
    expect(mocks.executeMulti).not.toHaveBeenCalled();
    expect(root.textContent).toContain("nativeJobs.outcomes.verified");
    expect(mocks.nativeJobOpenContext).toHaveBeenCalledTimes(1);
  });

  it("retains SQL input after partial success and re-previews only a corrected remaining field", async () => {
    const root = await mount();
    button(root, "nativeJobs.editJob").click();
    await flush();
    button(root, "nativeJobs.steps").click();
    await flush();
    input(root, "nativeJobs.fields.COMMAND_INPUT", "BEGIN work('private'); END;");
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.fields.COMMAND_INPUT"]')?.value).toBe("BEGIN work('private'); END;");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ configuration: { steps: [{ kind: "update", name: "sql", attributes: [{ name: "COMMAND_INPUT", change: { kind: "set", value: "BEGIN work('private'); END;" } }] }] } });
    if (details.steps.status === "available") details.steps.value[0]!.COMMAND = "BEGIN work('private'); END;";
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "operation",
      target,
      state: "finished",
      outcome: "partial",
      cancelRequested: false,
      steps: [
        { id: "steps:edit:0", state: "applied", reason: null, vendorCode: null },
        { id: "config_commit", state: "failed", reason: "native_failure", vendorCode: -1 },
      ],
      reason: "native_failure",
    });
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.outcomes.partial");
    button(root, "nativeJobs.correctDraft").click();
    await flush();
    button(root, "nativeJobs.steps").click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('[aria-label="nativeJobs.fields.COMMAND_INPUT"]')?.value).toBe("BEGIN work('private'); END;");
    input(root, "nativeJobs.fields.RETRY_INTERVAL", "10");
    button(root, "damengJobAdmin.previewSql").click();
    await flush();
    expect(request).toMatchObject({ configuration: { steps: [{ kind: "update", name: "sql", attributes: [{ name: "RETRY_INTERVAL", change: { kind: "set", value: 10 } }] }] } });
  });

  it("allows native stop when running metadata is unknown and does not label an accepted run successful", async () => {
    const root = await mount();
    expect(button(root, "damengJobAdmin.stopRunning").disabled).toBe(false);
    button(root, "damengJobAdmin.stopRunning").click();
    await flush();
    expect(request).toEqual({ action: "stop", target, baseline: "baseline" });
    mocks.nativeJobApply.mockResolvedValue({ operationId: "operation", target, state: "finished", outcome: "accepted", cancelRequested: false, steps: [{ id: "stop", state: "accepted", reason: null, vendorCode: null }], reason: null });
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.outcomes.accepted");
    expect(mocks.toast).not.toHaveBeenCalledWith("damengJobAdmin.applySuccess", expect.anything());
  });

  it("shows unavailable history rather than the empty-history state", async () => {
    const root = await mount();
    button(root, "damengJobAdmin.histories").click();
    await flush();
    expect(root.textContent).toContain("nativeJobs.partitionUnavailable");
    expect(root.textContent).not.toContain("damengJobAdmin.emptyDetails");
  });
  it.each(["unavailable", "uncertain"] as const)("keeps a single %s observation summary and preserves native diagnostics in the original record", async (association) => {
    const root = await mount();
    button(root, "damengJobAdmin.stopRunning").click();
    await flush();
    mocks.nativeJobApply.mockResolvedValue({
      operationId: "operation",
      target,
      state: "finished",
      outcome: "unknown",
      cancelRequested: false,
      steps: [{ id: "stop", state: "unknown", reason: "native_step_receipt_unknown", vendorCode: -1 }],
      reason: "native_job_step_outcome_unknown",
      executionObservation: { observedAt: "native observation time", association, reason: "native_history_unreadable", running: { status: "unknown", reason: "running_unreadable" }, history: { status: "denied", reason: "history_denied" }, sources: {}, candidates: [] },
    });
    button(root, "damengJobAdmin.applySql").click();
    await flush();
    const record = root.querySelector("details")!;
    expect(record).not.toBeNull();
    expect(record.open).toBe(false);
    expect(record.textContent).toContain("native_job_step_outcome_unknown");
    expect(record.textContent).toContain("native_step_receipt_unknown");
    expect(record.textContent).toContain("nativeJobs.observationReadStatus");
    expect(record.textContent).toContain("nativeJobs.observationEmpty");
    const primary = root.querySelector('section[aria-live="polite"]')!.cloneNode(true) as HTMLElement;
    primary.querySelectorAll("details").forEach((element) => element.remove());
    expect(primary.textContent).toContain("nativeJobs.outcomes.unknown");
    expect(primary.textContent).toContain(association === "uncertain" ? "nativeJobs.associationUncertain" : "nativeJobs.observationUnavailable");
    expect(primary.textContent).not.toContain("nativeJobs.observationReadStatus");
    expect(primary.textContent).not.toContain("nativeJobs.observationEmpty");
    expect(primary.textContent).not.toContain("native_job_step_outcome_unknown");
    expect(button(root, "nativeJobs.observeExecution").disabled).toBe(false);
    expect(mocks.nativeJobApply).toHaveBeenCalledTimes(1);
  });
});
