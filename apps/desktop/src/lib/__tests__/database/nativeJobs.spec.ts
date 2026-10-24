import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import {
  buildNativeJobDamengCreate,
  buildNativeJobDamengEdit,
  rebaseNativeJobDamengCreation,
  rebaseNativeJobDamengDraft,
  buildNativeJobEdit,
  nativeJobRefKey,
  oracleSchedulerObjectName,
  type NativeJobDamengEditDraft,
  type NativeJobDetails,
  type NativeJobOperationStatus,
  type NativeJobRef,
  type NativeJobSnapshot,
} from "@/lib/database/nativeJobs";

const scope = { connectionId: "connection-a", database: "tenant/schema", contextId: "context-1" };
const scheduler = (owner: string, name: string): NativeJobRef => ({ scope: { ...scope }, kind: "scheduler", owner, name });

describe("native Job identity", () => {
  it("keeps the exact scope and identifier components separate", () => {
    const selected = scheduler("owner.with.dot", "Job,One");
    const otherOwner = scheduler("owner", "with.dot.Job,One");
    expect(nativeJobRefKey(selected)).not.toBe(nativeJobRefKey(otherOwner));
    expect(nativeJobRefKey(selected)).not.toBe(nativeJobRefKey(scheduler("OWNER.WITH.DOT", "Job,One")));
    expect(nativeJobRefKey(selected)).not.toBe(nativeJobRefKey({ ...selected, scope: { ...scope, contextId: "context-2" } }));
    expect(nativeJobRefKey(selected)).toBe(nativeJobRefKey(structuredClone(selected)));
  });

  it("quotes a single native Scheduler object rather than a comma-separated list", () => {
    expect(oracleSchedulerObjectName(scheduler('owner"one', ' Job,Two." '))).toBe('"owner""one"." Job,Two."" "');
  });

  it("keeps numeric Job IDs above JavaScript's safe integer range distinct", () => {
    expect(nativeJobRefKey({ scope, kind: "legacy", jobId: "9007199254740993" })).not.toBe(nativeJobRefKey({ scope, kind: "legacy", jobId: "9007199254740994" }));
  });

  it.each([9007199254740992, "0", "1e3"])("rejects a lossy or noncanonical Job ID: %s", (jobId) => {
    expect(() => nativeJobRefKey({ scope, kind: "legacy", jobId } as NativeJobRef)).toThrow("native_job_id_invalid");
  });
});

function damengDetails(): NativeJobDetails {
  return {
    snapshot: { ref: { kind: "dameng-native", scope: { ...scope }, jobId: "41", name: "Job_1" }, revision: "revision", definition: { status: "available", value: { DESCRIBE: "keep job", ENABLE: false } }, arguments: { status: "empty" } },
    nativeIdentity: { status: "available", value: { DBX_JOB_ID: "41", DBX_CREATED_AT: "creation" } },
    consistency: { status: "available", value: null },
    parameterMetadata: { status: "unsupported", reason: "not_applicable" },
    steps: {
      status: "available",
      value: [
        { ID: "11", NAME: "backup", TYPE: 6, COMMAND: "native generated backup command", DESCRIBE: "keep backup" },
        { ID: "12", NAME: "sql", TYPE: 0, COMMAND: "SELECT 1;", RETRY_INTERVAL: 0 },
      ],
    },
    schedules: { status: "available", value: [{ ID: "21", NAME: "daily", ENABLE: true, DURING_END_DATE: null, DESCRIBE: "keep schedule" }] },
    running: { status: "unknown", reason: "not_readable" },
    history: { status: "empty" },
    sources: {},
  };
}

describe("Dameng configuration draft", () => {
  it("rebases a renamed parent and child only by frozen identities while retaining unfinished fields", () => {
    const before = damengDetails();
    const after = damengDetails();
    after.snapshot.ref = { kind: "dameng-native", scope, jobId: "41", name: "Renamed Job" };
    after.snapshot.definition = { status: "available", value: { NAME: "Renamed Job", ENABLE: false } };
    if (after.steps.status === "available") after.steps.value[1]!.NAME = "renamed_sql";
    after.schedules = { status: "empty" };
    after.sources.schedules = { source: "SYSJOB.SYSJOBSCHEDULES", coverage: "database" };
    const draft: NativeJobDamengEditDraft = {
      attributes: { NAME: { kind: "set", value: "Renamed Job" }, ENABLE: { kind: "set", value: true } },
      steps: [{ kind: "update", name: "sql", attributes: { NAME: { kind: "set", value: "renamed_sql" }, COMMAND_INPUT: { kind: "set", value: "SELECT 1;" }, RETRY_INTERVAL: { kind: "set", value: 7 } } }],
      schedules: [{ kind: "drop", name: "daily" }],
    };
    const status: NativeJobOperationStatus = { operationId: "rename", target: after.snapshot.ref, state: "finished", outcome: "partial", cancelRequested: false, steps: [], reason: "enable_failed" };
    const corrected = rebaseNativeJobDamengDraft(before, after, draft, status, "Owner");
    expect(corrected.attributes).toEqual({ ENABLE: { kind: "set", value: true } });
    expect(corrected.steps).toEqual([{ kind: "update", name: "renamed_sql", attributes: { RETRY_INTERVAL: { kind: "set", value: 7 } } }]);
    expect(corrected.schedules).toEqual([]);
    const unknown = rebaseNativeJobDamengDraft(before, after, draft, { ...status, outcome: "unknown" }, "Owner");
    expect(unknown.attributes?.NAME).toEqual(draft.attributes?.NAME);
    expect(unknown.schedules).toEqual([{ kind: "drop", name: "daily", attributes: {} }]);
    expect(draft.steps?.[0]?.name).toBe("sql");
    after.nativeIdentity = { status: "available", value: { DBX_JOB_ID: "41", DBX_CREATED_AT: "replacement" } };
    expect(() => rebaseNativeJobDamengDraft(before, after, draft, status, "Owner")).toThrow("native_job_identity_mismatch");
  });

  it("does not use rounded numeric child identities to adopt a retained create", () => {
    const details = damengDetails();
    details.steps = { status: "available", value: [{ ID: 9007199254740992, NAME: "new_step" }] };
    const draft: NativeJobDamengEditDraft = { steps: [{ kind: "add", name: "new_step", attributes: {} }] };
    const status: NativeJobOperationStatus = { operationId: "create", target: details.snapshot.ref, state: "finished", outcome: "partial", cancelRequested: false, steps: [], reason: null, createdChildren: [{ partition: "steps", name: "new_step", id: "9007199254740992" }] };
    expect(rebaseNativeJobDamengCreation(details, draft, status).steps?.[0]?.kind).toBe("add");
    details.steps.value[0]!.DBX_CHILD_ID = "9007199254740992";
    expect(rebaseNativeJobDamengCreation(details, draft, status).steps?.[0]?.kind).toBe("update");
  });
  it("builds native creation with one activation choice and all steps without inventing a target", () => {
    const draft = reactive<NativeJobDamengEditDraft>({ attributes: { ENABLE: { kind: "set", value: false }, DESCRIBE: { kind: "clear" } }, steps: [{ kind: "add", name: "STEP1", attributes: { COMMAND_INPUT: { kind: "set", value: "BEGIN work('private'); END;" } } }], schedules: [] });
    const request = buildNativeJobDamengCreate(scope, "New_job", draft);
    expect(request).toEqual({
      action: "create",
      scope,
      definition: {
        kind: "dameng-native",
        name: "New_job",
        enabled: false,
        configuration: { attributes: [{ name: "DESCRIBE", change: { kind: "clear" } }], steps: [{ kind: "add", name: "STEP1", attributes: [{ name: "COMMAND_INPUT", change: { kind: "set", value: "BEGIN work('private'); END;" } }] }], schedules: [] },
      },
    });
    draft.steps![0]!.attributes!.COMMAND_INPUT = { kind: "set", value: "changed after preview" };
    expect(JSON.stringify(request)).toContain("BEGIN work('private'); END;");
    expect(request).not.toHaveProperty("target");
    expect(request.scope).not.toBe(scope);
    expect(buildNativeJobDamengCreate(scope, "Default_job", {}).definition).toMatchObject({ enabled: true });
  });

  it("rejects existing-child actions and invalid activation values before a create preview", () => {
    expect(() => buildNativeJobDamengCreate(scope, "New_job", { steps: [{ kind: "drop", name: "old" }] })).toThrow("native_job_creation_children_must_be_new");
    expect(() => buildNativeJobDamengCreate(scope, "New_job", { attributes: { ENABLE: { kind: "clear" } } })).toThrow("native_job_attribute_type_invalid");
    expect(() => buildNativeJobDamengCreate(scope, "New_job", { attributes: { ENABLE: { kind: "set", value: "true" } } })).toThrow("native_job_attribute_type_invalid");
  });

  it("rebases only acknowledged created child identities and keeps the remaining input", () => {
    const details = damengDetails();
    const draft: NativeJobDamengEditDraft = {
      steps: [{ kind: "add", name: "sql", attributes: { COMMAND_INPUT: { kind: "set", value: "SELECT 1;" }, RETRY_INTERVAL: { kind: "set", value: 7 } } }],
      schedules: [{ kind: "add", name: "new_daily", attributes: { DURING_START_DATE: { kind: "set", value: "CURDATE" } } }],
    };
    const status: NativeJobOperationStatus = { operationId: "operation", target: details.snapshot.ref, state: "finished", outcome: "partial", cancelRequested: false, steps: [], reason: "native_failure", createdChildren: [{ partition: "steps", name: "sql", id: "12" }] };
    const corrected = rebaseNativeJobDamengCreation(details, draft, status);
    expect(corrected.steps?.[0]?.kind).toBe("update");
    expect(corrected.schedules?.[0]?.kind).toBe("add");
    expect(buildNativeJobDamengEdit(details, corrected).configuration.steps).toEqual([{ kind: "update", name: "sql", attributes: [{ name: "RETRY_INTERVAL", change: { kind: "set", value: 7 } }] }]);
    expect(draft.steps?.[0]?.kind).toBe("add");
    status.createdChildren![0]!.id = "replacement";
    expect(rebaseNativeJobDamengCreation(details, draft, status).steps?.[0]?.kind).toBe("add");
    status.createdChildren = [];
    expect(rebaseNativeJobDamengCreation(details, draft, status).steps?.[0]?.kind).toBe("add");
  });

  it("does not turn native integer flags into unnecessary checkbox edits", () => {
    const details = damengDetails();
    if (details.snapshot.definition.status === "available") details.snapshot.definition.value.ENABLE = 1;
    if (details.steps.status === "available") details.steps.value[1]!.APPEND_FLAG = 0;
    const request = buildNativeJobDamengEdit(details, { attributes: { ENABLE: { kind: "set", value: true } }, steps: [{ kind: "update", name: "sql", attributes: { APPEND_FLAG: { kind: "set", value: false } } }] });
    expect(request.configuration).toEqual({ attributes: [], steps: [], schedules: [] });
  });
  it("changes only selected child fields and does not turn a generated command into native input", () => {
    const details = damengDetails();
    const before = structuredClone(details);
    const request = buildNativeJobDamengEdit(details, {
      attributes: { DESCRIBE: { kind: "set", value: "keep job" } },
      steps: [{ kind: "update", name: "backup", attributes: { DESCRIBE: { kind: "set", value: "new description" } } }],
    });
    expect(request.configuration).toEqual({ attributes: [], steps: [{ kind: "update", name: "backup", attributes: [{ name: "DESCRIBE", change: { kind: "set", value: "new description" } }] }], schedules: [] });
    expect(details).toEqual(before);
  });

  it("omits already applied SQL edits and keeps explicit backup input even if it resembles catalog text", () => {
    const details = damengDetails();
    const request = buildNativeJobDamengEdit(details, {
      steps: [
        { kind: "update", name: "sql", attributes: { COMMAND_INPUT: { kind: "set", value: "SELECT 1;" }, RETRY_INTERVAL: { kind: "set", value: 0 } } },
        { kind: "update", name: "backup", attributes: { COMMAND_INPUT: { kind: "set", value: "native generated backup command" } } },
      ],
    });
    expect(request.configuration.steps).toEqual([{ kind: "update", name: "backup", attributes: [{ name: "COMMAND_INPUT", change: { kind: "set", value: "native generated backup command" } }] }]);
    const switched = buildNativeJobDamengEdit(details, { steps: [{ kind: "update", name: "sql", attributes: { TYPE: { kind: "set", value: 6 }, COMMAND_INPUT: { kind: "set", value: "SELECT 1;" } } }] });
    expect(switched.configuration.steps?.[0]).toMatchObject({
      attributes: [
        { name: "TYPE", change: { value: 6 } },
        { name: "COMMAND_INPUT", change: { value: "SELECT 1;" } },
      ],
    });
  });

  it("preserves add/drop intent and clear semantics without sending unchanged schedules", () => {
    const details = damengDetails();
    const request = buildNativeJobDamengEdit(details, {
      steps: [
        { kind: "add", name: "next_step", attributes: { COMMAND_INPUT: { kind: "set", value: "SELECT 2;" } } },
        { kind: "drop", name: "sql" },
      ],
      schedules: [{ kind: "update", name: "daily", attributes: { DURING_END_DATE: { kind: "clear" } } }],
    });
    expect(request.configuration.steps).toEqual([
      { kind: "add", name: "next_step", attributes: [{ name: "COMMAND_INPUT", change: { kind: "set", value: "SELECT 2;" } }] },
      { kind: "drop", name: "sql" },
    ]);
    expect(request.configuration.schedules).toEqual([]);
  });

  it.each(["denied", "unknown", "truncated"] as const)("keeps a %s step partition from being rewritten while allowing a schedule-only edit", (status) => {
    const details = damengDetails();
    details.steps = status === "truncated" ? { status, value: [], limit: 1 } : { status, reason: "not_available" };
    expect(() => buildNativeJobDamengEdit(details, { steps: [{ kind: "drop", name: "sql" }] })).toThrow("native_job_metadata_incomplete");
    expect(buildNativeJobDamengEdit(details, { schedules: [{ kind: "drop", name: "daily" }] }).configuration.schedules).toEqual([{ kind: "drop", name: "daily" }]);
  });

  it("detaches nested drafts and refuses missing children instead of guessing after a refresh", () => {
    const details = reactive(damengDetails());
    const input = reactive({ kind: "set" as const, value: "original body" });
    const request = buildNativeJobDamengEdit(details, { steps: [{ kind: "add", name: "new_step", attributes: { COMMAND_INPUT: input } }] });
    input.value = "later body";
    details.snapshot.ref.scope.contextId = "new context";
    expect(request.target.scope.contextId).toBe("context-1");
    expect(request.configuration.steps?.[0]).toMatchObject({ attributes: [{ change: { value: "original body" } }] });
    expect(() => buildNativeJobDamengEdit(details, { steps: [{ kind: "drop", name: "missing" }] })).toThrow("native_job_child_missing");
  });
});

describe("native Job edit draft", () => {
  it("changes only the chosen field without requiring unreadable arguments or rewriting opaque values", () => {
    const snapshot: NativeJobSnapshot = {
      ref: scheduler("OWNER", "Job"),
      revision: "server-revision-1",
      definition: { status: "available", value: { comments: "old", end_date: null, advanced: { raw: ["unchanged", 7] } } },
      arguments: { status: "denied", reason: "ORA-01031" },
    };
    const before = structuredClone(snapshot);
    expect(
      buildNativeJobEdit(snapshot, {
        attributes: { comments: { kind: "set", value: "new" }, end_date: { kind: "keep" } },
      }),
    ).toEqual({
      action: "update",
      target: snapshot.ref,
      baseline: "server-revision-1",
      attributes: [{ name: "comments", change: { kind: "set", value: "new" } }],
      arguments: [],
    });
    expect(snapshot).toEqual(before);
  });

  it("preserves unset, inherited, NULL and opaque arguments while sending only requested overrides", () => {
    const snapshot: NativeJobSnapshot = {
      ref: scheduler("OWNER", "Job"),
      revision: "server-revision-2",
      definition: { status: "available", value: {} },
      arguments: {
        status: "available",
        value: [
          { position: 1, dataType: "VARCHAR2", value: { kind: "inherit" }, editable: true },
          { position: 2, dataType: "VARCHAR2", value: { kind: "value", value: "text" }, editable: true },
          { position: 3, dataType: "ANYDATA", value: { kind: "opaque", value: { native: "unchanged" } }, editable: false },
          { position: 4, dataType: "NUMBER", value: { kind: "null" }, editable: true },
          { position: 5, dataType: "DATE", value: { kind: "unset" }, editable: true },
        ],
      },
    };
    const before = structuredClone(snapshot);
    const edit = buildNativeJobEdit(snapshot, {
      arguments: [
        { position: 2, value: { kind: "inherit" } },
        { position: 1, value: { kind: "null" } },
        { position: 3, value: { kind: "opaque", value: { native: "unchanged" } } },
        { position: 4, value: { kind: "null" } },
        { position: 5, value: { kind: "unset" } },
      ],
    });
    expect(edit.arguments).toEqual([
      { position: 1, value: { kind: "null" } },
      { position: 2, value: { kind: "inherit" } },
    ]);
    expect(snapshot).toEqual(before);
  });

  it.each(["denied", "unknown", "truncated"] as const)("blocks argument edits on %s metadata and retains the draft", (status) => {
    const snapshot: NativeJobSnapshot = {
      ref: scheduler("OWNER", "Job"),
      revision: "baseline",
      definition: { status: "available", value: { comments: "old" } },
      arguments: status === "truncated" ? { status, value: [], limit: 1 } : { status, reason: "not available" },
    };
    const draft = { arguments: [{ position: 1, value: { kind: "null" as const } }] };
    const before = structuredClone(draft);
    expect(() => buildNativeJobEdit(snapshot, draft)).toThrow("native_job_arguments_unavailable");
    expect(draft).toEqual(before);
    expect(buildNativeJobEdit(snapshot, { attributes: { comments: { kind: "set", value: "new" } } }).attributes).toHaveLength(1);
  });

  it("keeps opaque arguments read-only without making the rest of the Job read-only", () => {
    const snapshot: NativeJobSnapshot = {
      ref: scheduler("OWNER", "Job"),
      revision: "baseline",
      definition: { status: "available", value: { comments: "old" } },
      arguments: { status: "available", value: [{ position: 1, dataType: "ANYDATA", value: { kind: "opaque", value: "raw" }, editable: false }] },
    };
    expect(() => buildNativeJobEdit(snapshot, { arguments: [{ position: 1, value: { kind: "null" } }] })).toThrow("native_job_argument_not_editable");
    expect(buildNativeJobEdit(snapshot, { attributes: { comments: { kind: "set", value: "new" } } }).arguments).toEqual([]);
  });

  it("keeps clear, keep and unchanged compound values out of unrelated updates", () => {
    const snapshot: NativeJobSnapshot = {
      ref: scheduler("OWNER", "Job"),
      revision: "baseline",
      definition: { status: "available", value: { end_date: "2030-01-01T00:00:00+08:00", comments: null, advanced: { a: 1, b: [true, null] } } },
      arguments: { status: "empty" },
    };
    expect(
      buildNativeJobEdit(snapshot, {
        attributes: {
          end_date: { kind: "clear" },
          comments: { kind: "clear" },
          advanced: { kind: "set", value: { b: [true, null], a: 1 } },
        },
      }).attributes,
    ).toEqual([{ name: "end_date", change: { kind: "clear" } }]);
  });

  it("detaches the request from reactive targets and draft values before selection or input changes", () => {
    const snapshot = reactive<NativeJobSnapshot>({
      ref: scheduler("OWNER", "Original"),
      revision: "baseline",
      definition: { status: "available", value: {} },
      arguments: { status: "empty" },
    });
    const value = reactive({ values: ["confirmed"] });
    const edit = buildNativeJobEdit(snapshot, { attributes: { advanced: { kind: "set", value } } });
    snapshot.ref.scope.contextId = "different-context";
    value.values[0] = "later input";
    expect(edit.target.scope.contextId).toBe("context-1");
    expect(edit.attributes).toEqual([{ name: "advanced", change: { kind: "set", value: { values: ["confirmed"] } } }]);
  });
});
