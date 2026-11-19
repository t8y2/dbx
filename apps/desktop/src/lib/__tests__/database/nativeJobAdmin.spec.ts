import { describe, expect, it } from "vitest";
import {
  buildNativeJobDefinitionCreate,
  buildNativeJobDefinitionEdit,
  initializeNativeJobDefinitionEdit,
  nativeJobDefinitionForEdit,
  nativeJobAdminKinds,
  nativeJobAdminEngine,
  nativeJobAdminSupported,
  newNativeJobDefinitionDraft,
  nativeJobProgramArgumentLayout,
  rebaseNativeJobDefinitionCreation,
  restoreNativeJobDefinitionDraft,
  selectNativeJobArgumentContext,
  type NativeJobDefinitionDraft,
} from "@/lib/database/nativeJobAdmin";
import { buildNativeJobEdit, type NativeJobDetails, type NativeJobOperationStatus, type NativeJobRow } from "@/lib/database/nativeJobs";

const scope = { connectionId: "c", database: "", contextId: "context" };
describe("shared native Job admin adapter", () => {
  it("uses actual OceanBase compatibility mode only for Job capability on JDBC", () => {
    for (const driver_label of ["OceanBase", "Oracle", "Dameng"]) {
      const connection = { db_type: "jdbc" as const, connection_string: "jdbc:oceanbase://host/db", driver_label, database_info: { productName: "OceanBase", compatibilityMode: "ORACLE" } };
      expect(nativeJobAdminEngine(connection)).toBe("oceanbase-oracle");
      expect(nativeJobAdminSupported(connection)).toBe(true);
      for (const compatibilityMode of [undefined, "mysql", "unknown"]) {
        const unavailable = { ...connection, database_info: { productName: "OceanBase", compatibilityMode } };
        expect(nativeJobAdminEngine(unavailable)).toBeUndefined();
        expect(nativeJobAdminSupported(unavailable)).toBe(false);
      }
    }
  });
  it("supports Oracle thin, OCI, Oracle JDBC, OB Oracle and Dameng without changing Xugu", () => {
    for (const connection of [{ db_type: "oracle" as const }, { db_type: "oracle" as const, driver_profile: "oracle-oci" }, { db_type: "jdbc" as const, connection_string: "jdbc:oracle:thin:@host/service" }, { db_type: "oceanbase-oracle" as const }, { db_type: "dameng" as const }])
      expect(nativeJobAdminSupported(connection)).toBe(true);
    for (const db_type of ["xugu", "mysql", "oceanbase", "jdbc"] as const) expect(nativeJobAdminSupported({ db_type })).toBe(false);
    expect(nativeJobAdminKinds("oracle")).toEqual(["scheduler", "legacy"]);
    expect(nativeJobAdminKinds("dameng")).toEqual(["dameng-native", "scheduler", "legacy"]);
  });
  it("creates an inline Scheduler with explicit offset dates and retained advanced fields", () => {
    const draft = newNativeJobDefinitionDraft("scheduler");
    draft.attributes!.JOB_ACTION = { kind: "set", value: "BEGIN work('private'); END;" };
    draft.attributes!.START_DATE = { kind: "set", value: "2026-10-21T10:00:00+08:00" };
    draft.attributes!.MAX_FAILURES = { kind: "set", value: 7 };
    const request = buildNativeJobDefinitionCreate(scope, "oracle", "scheduler", "Exact.Owner", " Job,One ", draft);
    expect(request).toMatchObject({
      action: "create",
      scope,
      definition: { kind: "scheduler", owner: "Exact.Owner", name: " Job,One ", jobType: "PLSQL_BLOCK", jobAction: "BEGIN work('private'); END;", startDate: "2026-10-21T10:00:00+08:00", enabled: false, attributes: [{ name: "MAX_FAILURES", change: { kind: "set", value: 7 } }] },
    });
    expect(request).not.toHaveProperty("target");
  });
  it("uses exact program and schedule references rather than splitting qualified names or rewriting inactive inline input", () => {
    const draft = newNativeJobDefinitionDraft("scheduler");
    Object.assign(draft.attributes!, { PROGRAM_OWNER: { kind: "set", value: "Program.Owner" }, PROGRAM_NAME: { kind: "set", value: 'P,"One' }, SCHEDULE_OWNER: { kind: "set", value: "Calendar.Owner" }, SCHEDULE_NAME: { kind: "set", value: "Week.Name" } });
    const request = buildNativeJobDefinitionCreate(scope, "oracle", "scheduler", "Owner", "New_job", draft);
    expect(request.definition).toMatchObject({ program: { owner: "Program.Owner", name: 'P,"One' }, schedule: { owner: "Calendar.Owner", name: "Week.Name" }, numberOfArguments: 0 });
    expect(request.definition).not.toHaveProperty("jobType");
    expect(request.definition).not.toHaveProperty("startDate");
    expect(draft.attributes!.JOB_ACTION).toEqual({ kind: "set", value: "BEGIN NULL; END;" });
  });
  it("keeps Oracle instance and OceanBase zone distinct for targetless traditional creation", () => {
    const draft = newNativeJobDefinitionDraft("legacy");
    Object.assign(draft.attributes!, { WHAT: { kind: "set", value: "run_work();" }, NEXT_DATE: { kind: "set", value: "2026-10-21 10:00:00" }, ZONE: { kind: "set", value: "zone1" }, INSTANCE: { kind: "set", value: 2 } });
    const oracle = buildNativeJobDefinitionCreate(scope, "oracle", "legacy", "Exact Owner", "", draft);
    expect(oracle.definition).toMatchObject({ kind: "legacy", schema: "Exact Owner", instance: 2, enabled: false });
    expect(oracle.definition).not.toHaveProperty("zone");
    const ob = buildNativeJobDefinitionCreate(scope, "oceanbase-oracle", "legacy", "Owner", "", draft);
    expect(ob.definition).toMatchObject({ kind: "legacy", zone: "zone1", enabled: false });
    expect(ob.definition).not.toHaveProperty("instance");
  });
  it("retains argument drafts by exact Program identity without applying inactive inline or other Program overrides", () => {
    const draft = newNativeJobDefinitionDraft("scheduler");
    draft.arguments = [{ position: 1, value: { kind: "value", value: "inline original" } }];
    draft.argumentTypes = { 1: "VARCHAR2" };
    draft.attributes!.PROGRAM_NAME = { kind: "set", value: "Program.One" };
    expect(buildNativeJobDefinitionCreate(scope, "oracle", "scheduler", "Owner", "Job", draft).definition).toMatchObject({ arguments: [] });
    selectNativeJobArgumentContext(draft, "Owner", "Program.One");
    expect(draft.arguments).toEqual([]);
    draft.arguments!.push({ position: 2, value: { kind: "value", value: "program override" } });
    draft.argumentTypes![2] = "NUMBER";
    selectNativeJobArgumentContext(draft, "Another.Owner", "Program.One");
    expect(draft.arguments).toEqual([]);
    selectNativeJobArgumentContext(draft, "Owner", "Program.One");
    expect(draft.arguments).toEqual([{ position: 2, value: { kind: "value", value: "program override" } }]);
    selectNativeJobArgumentContext(draft, "Owner");
    expect(draft.arguments).toEqual([{ position: 1, value: { kind: "value", value: "inline original" } }]);
    expect(draft.argumentTypes).toEqual({ 1: "VARCHAR2" });
  });
  it("captures the original Scheduler enabled intent and argument context before a conversion can pause it", () => {
    const details = { snapshot: { ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" }, definition: { status: "available", value: { ENABLED: "TRUE", PROGRAM_OWNER: "Other.Owner", PROGRAM_NAME: "Program.A" } } } } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = { arguments: [{ position: 1, value: { kind: "value", value: "original override" } }], argumentTypes: { 1: "VARCHAR2" } };
    initializeNativeJobDefinitionEdit(details, draft);
    expect(draft.finalEnabled).toBe(true);
    expect(draft.argumentContext).toBe(JSON.stringify(["Other.Owner", "Program.A"]));
    selectNativeJobArgumentContext(draft, "Other.Owner", "Program.B");
    expect(draft.arguments).toEqual([]);
    if (details.snapshot.definition.status === "available") details.snapshot.definition.value.ENABLED = false;
    initializeNativeJobDefinitionEdit(details, draft);
    expect(draft.finalEnabled).toBe(true);
    expect(draft.argumentContext).toBe(JSON.stringify(["Other.Owner", "Program.B"]));
    selectNativeJobArgumentContext(draft, "Other.Owner", "Program.A");
    expect(draft.arguments).toEqual([{ position: 1, value: { kind: "value", value: "original override" } }]);
    expect(draft.argumentTypes).toEqual({ 1: "VARCHAR2" });
    draft.finalEnabled = false;
    initializeNativeJobDefinitionEdit(details, draft);
    expect(draft.finalEnabled).toBe(false);
  });
  it("sends a complete new Program context without copying old-position overrides or inactive inline fields", () => {
    const details = {
      snapshot: {
        ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" },
        revision: "before",
        definition: { status: "available", value: { ENABLED: true, PROGRAM_OWNER: "Owner", PROGRAM_NAME: "A", JOB_TYPE: null, JOB_ACTION: null, NUMBER_OF_ARGUMENTS: null } },
        arguments: { status: "available", value: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "old secret" }, editable: true }] },
      },
    } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = {};
    initializeNativeJobDefinitionEdit(details, draft);
    selectNativeJobArgumentContext(draft, "Other.Owner", "New,Program");
    draft.attributes = { PROGRAM_OWNER: { kind: "set", value: "Other.Owner" }, PROGRAM_NAME: { kind: "set", value: "New,Program" }, JOB_TYPE: { kind: "set", value: "STORED_PROCEDURE" }, JOB_ACTION: { kind: "set", value: "inactive_proc" }, NUMBER_OF_ARGUMENTS: { kind: "set", value: 7 } };
    draft.argumentLayouts = { [draft.argumentContext!]: { status: "available", value: [{ position: 1, dataType: "NUMBER", value: { kind: "inherit" }, editable: true }] } };
    const request = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(request.attributes).toEqual([{ name: "PROGRAM_NAME", change: { kind: "set", value: { owner: "Other.Owner", name: "New,Program" } } }]);
    expect(request.arguments).toEqual([]);
    expect(request.argumentTarget).toEqual({ program: { owner: "Other.Owner", name: "New,Program" }, arguments: [{ position: 1, dataType: "NUMBER", value: { kind: "inherit" } }] });
    expect(request.finalEnabled).toBe(true);
    details.snapshot.revision = "partial";
    details.snapshot.definition = { status: "available", value: { ENABLED: false, PROGRAM_OWNER: "Other.Owner", PROGRAM_NAME: "New,Program", JOB_TYPE: null, JOB_ACTION: null, NUMBER_OF_ARGUMENTS: null } };
    const remaining = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(remaining.attributes).toEqual([]);
    expect(remaining.argumentTarget).toEqual(request.argumentTarget);
    expect(remaining.finalEnabled).toBe(true);
    expect(draft.attributes.JOB_ACTION).toEqual({ kind: "set", value: "inactive_proc" });
  });
  it("leaves ordinary edits on their old delta contract and drops identical exact references", () => {
    const details = { snapshot: { ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" }, revision: "read", definition: { status: "available", value: { ENABLED: true, PROGRAM_OWNER: "Owner", PROGRAM_NAME: "A", COMMENTS: "old" } }, arguments: { status: "empty" } } } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = { attributes: { PROGRAM_OWNER: { kind: "set", value: "Owner" }, PROGRAM_NAME: { kind: "set", value: "A" }, COMMENTS: { kind: "set", value: "new" } } };
    initializeNativeJobDefinitionEdit(details, draft);
    const request = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(request.attributes).toEqual([{ name: "COMMENTS", change: { kind: "set", value: "new" } }]);
    expect(request).not.toHaveProperty("finalEnabled");
    expect(request).not.toHaveProperty("argumentTarget");
    if (details.snapshot.definition.status === "available") delete details.snapshot.definition.value.PROGRAM_OWNER;
    expect(buildNativeJobDefinitionEdit(details, "oracle", { attributes: { COMMENTS: { kind: "set", value: "new" } } }).attributes).toEqual([{ name: "COMMENTS", change: { kind: "set", value: "new" } }]);
  });
  it("uses complete Program descriptions, keeps unknown defaults unknown and prevents metadata overrides", () => {
    const program = { status: "available" as const, value: { NUMBER_OF_ARGUMENTS: 2 } };
    const args = {
      status: "available" as const,
      value: [
        { ARGUMENT_POSITION: 1, ARGUMENT_TYPE: "NUMBER", DEFAULT_VALUE: null },
        { ARGUMENT_POSITION: 2, ARGUMENT_TYPE: "SYS.AQ$_JMS_TEXT_MESSAGE", METADATA_ATTRIBUTE: "EVENT_MESSAGE", OUT_ARGUMENT: false },
      ],
    };
    const layout = nativeJobProgramArgumentLayout(program, args);
    expect(layout).toMatchObject({
      status: "available",
      value: [
        { position: 1, value: { kind: "inherit" }, editable: true, defaultValue: { status: "unknown" } },
        { position: 2, editable: false, metadataAttribute: "EVENT_MESSAGE" },
      ],
    });
    expect(nativeJobProgramArgumentLayout(program, { status: "empty" }).status).toBe("unknown");
    expect(nativeJobProgramArgumentLayout(program, { status: "truncated", value: args.value, limit: 2 })).toEqual({ status: "unknown", reason: "native_job_arguments_truncated" });
    expect(nativeJobProgramArgumentLayout({ status: "available", value: { NUMBER_OF_ARGUMENTS: 0 } }, { status: "empty" })).toEqual({ status: "available", value: [] });
  });
  it("uses backend-decoded defaults before misleading string projections and never parses ANYDATA locators", () => {
    const typed = { kind: "value", value: { $dbx: "oracle-anydata-v1", scalarType: "number", value: "9.007199254740993E15" } };
    const rows: NativeJobRow[] = [
      { ARGUMENT_POSITION: 1, DEFAULT_VALUE: "wrong fallback", DEFAULT_ANYDATA_VALUE: "locator", DBX_ARGUMENT_DEFAULT: { status: "available", value: typed } },
      { ARGUMENT_POSITION: 2, DEFAULT_VALUE: "also wrong", DBX_ANYDATA_PRESENT: 1, DEFAULT_ANYDATA_VALUE: "opaque locator" },
      { ARGUMENT_POSITION: 3, DEFAULT_VALUE: "plain text", DBX_ANYDATA_PRESENT: 0 },
    ];
    const layout = nativeJobProgramArgumentLayout({ status: "available", value: { NUMBER_OF_ARGUMENTS: 3 } }, { status: "available", value: rows });
    expect(layout).toMatchObject({
      status: "available",
      value: [
        { position: 1, defaultValue: { status: "available", value: typed } },
        { position: 2, defaultValue: { status: "available", value: { kind: "opaque", value: "opaque locator" } } },
        { position: 3, defaultValue: { status: "available", value: { kind: "value", value: "plain text" } } },
      ],
    });
  });
  it("keeps final intent for a remaining Schedule activation without requiring unrelated Program metadata", () => {
    const details = {
      snapshot: { ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" }, revision: "before", definition: { status: "available", value: { ENABLED: true, PROGRAM_NAME: "Unreadable owner", SCHEDULE_OWNER: null, SCHEDULE_NAME: null } }, arguments: { status: "denied", reason: "not readable" } },
    } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = {};
    initializeNativeJobDefinitionEdit(details, draft);
    draft.transitionRetained = true;
    draft.attributes = { SCHEDULE_OWNER: { kind: "set", value: "SYS" }, SCHEDULE_NAME: { kind: "set", value: "Window.Group" } };
    draft.referenceKinds = { SCHEDULE_NAME: "window-group" };
    expect(buildNativeJobDefinitionEdit(details, "oracle", draft)).toMatchObject({ finalEnabled: true, attributes: [{ name: "SCHEDULE_NAME", change: { kind: "set", value: { owner: "SYS", name: "Window.Group", kind: "window-group" } } }] });
    details.snapshot.definition = { status: "available", value: { ENABLED: false, PROGRAM_NAME: "Unreadable owner", SCHEDULE_OWNER: "SYS", SCHEDULE_NAME: "Window.Group", SCHEDULE_TYPE: "WINDOW_GROUP" } };
    const remaining = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(remaining).toMatchObject({ finalEnabled: true, attributes: [], arguments: [] });
    expect(remaining).not.toHaveProperty("argumentTarget");
  });
  it("does not invent an enabled intent from missing metadata or for a traditional Job", () => {
    const draft: NativeJobDefinitionDraft = {};
    const details = { snapshot: { ref: { kind: "legacy", scope, jobId: "41" }, definition: { status: "available", value: { BROKEN: "N" } } } } as NativeJobDetails;
    initializeNativeJobDefinitionEdit(details, draft);
    expect(draft).toEqual({});
    details.snapshot.ref = { kind: "scheduler", scope, owner: "Owner", name: "Job" };
    details.snapshot.definition = { status: "unknown", reason: "unreadable" };
    initializeNativeJobDefinitionEdit(details, draft);
    expect(draft).toEqual({});
  });
  it("projects exact credential and destination components without reinterpreting an old host destination", () => {
    const native = { status: "available" as const, value: { CREDENTIAL_OWNER: "Credentials.Owner", CREDENTIAL_NAME: 'Login,One"', CONNECT_CREDENTIAL_OWNER: null, CONNECT_CREDENTIAL_NAME: null, DESTINATION_OWNER: "Remote.Owner", DESTINATION: "Remote.DB" } };
    const projected = nativeJobDefinitionForEdit("oracle", "scheduler", native);
    expect(projected).toMatchObject({ status: "available", value: { CREDENTIAL_NAME: { owner: "Credentials.Owner", name: 'Login,One"' }, CONNECT_CREDENTIAL_NAME: null, DESTINATION_NAME: { owner: "Remote.Owner", name: "Remote.DB" }, DESTINATION: "Remote.DB" } });
    expect(native.value.CREDENTIAL_NAME).toBe('Login,One"');
    const host = nativeJobDefinitionForEdit("oracle", "scheduler", { status: "available", value: { DESTINATION_OWNER: null, DESTINATION: "host.example:15000" } });
    expect(host).toMatchObject({ status: "available", value: { DESTINATION: "host.example:15000" } });
    if (host.status === "available") expect(host.value).not.toHaveProperty("DESTINATION_NAME");
  });
  it("restores the original target into a new preview while retaining the inactive target's argument draft", () => {
    const details = {
      snapshot: {
        ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" },
        revision: "before",
        definition: {
          status: "available",
          value: {
            ENABLED: true,
            PROGRAM_OWNER: "Owner",
            PROGRAM_NAME: "A",
            JOB_TYPE: null,
            JOB_ACTION: null,
            NUMBER_OF_ARGUMENTS: null,
            SCHEDULE_OWNER: null,
            SCHEDULE_NAME: null,
            SCHEDULE_TYPE: "CALENDAR",
            START_DATE: "2030-01-01T00:00:00+08:00",
            END_DATE: null,
            REPEAT_INTERVAL: "FREQ=DAILY",
            COMMENTS: "original",
          },
        },
        arguments: { status: "available", value: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "original override" }, editable: true }] },
      },
    } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = {};
    initializeNativeJobDefinitionEdit(details, draft);
    selectNativeJobArgumentContext(draft, "Other.Owner", "B");
    draft.arguments = [{ position: 1, value: { kind: "value", value: "target B input" } }];
    draft.attributes = { PROGRAM_OWNER: { kind: "set", value: "Other.Owner" }, PROGRAM_NAME: { kind: "set", value: "B" }, COMMENTS: { kind: "set", value: "target comment" } };
    details.snapshot.revision = "after-partial";
    details.snapshot.definition = { status: "available", value: { ...details.snapshot.definition.value, ENABLED: false, PROGRAM_OWNER: "Other.Owner", PROGRAM_NAME: "B" } };
    restoreNativeJobDefinitionDraft(draft);
    const request = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(request).toMatchObject({
      baseline: "after-partial",
      finalEnabled: true,
      attributes: [{ name: "PROGRAM_NAME", change: { kind: "set", value: { owner: "Owner", name: "A" } } }],
      argumentTarget: { program: { owner: "Owner", name: "A" }, arguments: [{ position: 1, dataType: "VARCHAR2", value: { kind: "value", value: "original override" } }] },
    });
    expect(draft.originalSnapshot?.definition).toMatchObject({ status: "available", value: { ENABLED: true, PROGRAM_NAME: "A" } });
    selectNativeJobArgumentContext(draft, "Other.Owner", "B");
    expect(draft.arguments).toEqual([{ position: 1, value: { kind: "value", value: "target B input" } }]);
  });
  it("creates queue and file arrival triggers without sending the inactive named or calendar schedule", () => {
    for (const scheduleMode of ["queue", "file-watcher"] as const) {
      const draft = newNativeJobDefinitionDraft("scheduler");
      draft.attributes!.SCHEDULE_NAME = { kind: "set", value: "inactive schedule" };
      draft.attributes!.REPEAT_INTERVAL = { kind: "set", value: "FREQ=DAILY" };
      draft.scheduleMode = scheduleMode;
      draft.eventDraft = { condition: "tab.user_data.ready = 'Y'", queueOwner: "Queue.Owner", queueName: "Q,1", agent: "Agent.One", watcherOwner: "Watch.Owner", watcherName: 'Arrival,"One' };
      const definition = buildNativeJobDefinitionCreate(scope, "oracle", "scheduler", "Owner", "New", draft).definition;
      expect(definition).toMatchObject({ eventCondition: "tab.user_data.ready = 'Y'", eventSource: scheduleMode === "queue" ? { kind: "queue", owner: "Queue.Owner", name: "Q,1", agent: "Agent.One" } : { kind: "file-watcher", reference: { owner: "Watch.Owner", name: 'Arrival,"One' } } });
      expect(definition).not.toHaveProperty("schedule");
      expect(definition).not.toHaveProperty("repeatInterval");
    }
  });
  it("edits an event trigger with exact source components and preserves unrelated opaque parameter metadata", () => {
    const details = {
      snapshot: {
        ref: { kind: "scheduler", scope, owner: "Owner", name: "Job" },
        revision: "read",
        definition: {
          status: "available",
          value: {
            ENABLED: true,
            PROGRAM_OWNER: "Unknown.ProgramOwner",
            PROGRAM_NAME: "Program",
            SCHEDULE_OWNER: "Calendar.Owner",
            SCHEDULE_NAME: "Calendar",
            SCHEDULE_TYPE: "NAMED",
            EVENT_QUEUE_OWNER: null,
            EVENT_QUEUE_NAME: null,
            FILE_WATCHER_OWNER: null,
            FILE_WATCHER_NAME: null,
            EVENT_CONDITION: null,
          },
        },
        arguments: { status: "denied", reason: "no argument access" },
      },
    } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = {};
    initializeNativeJobDefinitionEdit(details, draft);
    draft.scheduleMode = "queue";
    draft.eventDraft = { condition: "tab.user_data.flag = 'Y'", queueOwner: "Queue.Owner", queueName: 'Q,"One', agent: "Exact.Agent", watcherOwner: "", watcherName: "" };
    const request = buildNativeJobDefinitionEdit(details, "oracle", draft);
    expect(request).toMatchObject({
      finalEnabled: true,
      attributes: [
        { name: "SCHEDULE_NAME", change: { kind: "clear" } },
        { name: "EVENT_SPEC", change: { kind: "set", value: { condition: "tab.user_data.flag = 'Y'", source: { kind: "queue", owner: "Queue.Owner", name: 'Q,"One', agent: "Exact.Agent" } } } },
      ],
    });
    expect(request).not.toHaveProperty("argumentTarget");
    expect(request.arguments).toEqual([]);
  });
  it("shares the OB Legacy Zone projection for no-op comparison without changing native INSTANCE", () => {
    const original = { status: "available" as const, value: { INSTANCE: "zone1", WHAT: "kept();" } };
    const definition = nativeJobDefinitionForEdit("oceanbase-oracle", "legacy", original);
    const snapshot = { ref: { kind: "legacy" as const, scope, jobId: "41" }, revision: "read", definition, arguments: { status: "empty" as const } };
    expect(buildNativeJobEdit(snapshot, { attributes: { ZONE: { kind: "set", value: "zone1" } } }).attributes).toEqual([]);
    expect(buildNativeJobEdit(snapshot, { attributes: { ZONE: { kind: "clear" } } }).attributes).toEqual([{ name: "ZONE", change: { kind: "clear" } }]);
    expect(original.value).toEqual({ INSTANCE: "zone1", WHAT: "kept();" });
    expect(nativeJobDefinitionForEdit("oracle", "legacy", original)).toBe(original);
    snapshot.definition = nativeJobDefinitionForEdit("oceanbase-oracle", "legacy", { status: "available", value: { INSTANCE: null } });
    expect(buildNativeJobEdit(snapshot, { attributes: { ZONE: { kind: "clear" } } }).attributes).toEqual([]);
  });
  it("restores an original host through the raw destination slot rather than a named-reference clear", () => {
    const original = {
      snapshot: {
        ref: { kind: "scheduler", scope, owner: "Owner", name: "Host_job" },
        revision: "original",
        definition: { status: "available", value: { ENABLED: true, PROGRAM_OWNER: null, PROGRAM_NAME: null, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "proc", NUMBER_OF_ARGUMENTS: 0, SCHEDULE_OWNER: null, SCHEDULE_NAME: null, DESTINATION_OWNER: null, DESTINATION: "Host.With.Dots:1500" } },
        arguments: { status: "available", value: [] },
      },
    } as NativeJobDetails;
    const draft: NativeJobDefinitionDraft = {};
    initializeNativeJobDefinitionEdit(original, draft);
    draft.attributes = { DESTINATION_NAME: { kind: "set", value: { owner: "Remote.Owner", name: "Named" } } };
    const current = structuredClone(original);
    if (current.snapshot.definition.status !== "available") throw new Error("fixture definition");
    Object.assign(current.snapshot.definition.value, { DESTINATION_OWNER: "Remote.Owner", DESTINATION: "Named" });
    restoreNativeJobDefinitionDraft(draft, current);
    const request = buildNativeJobDefinitionEdit(current, "oracle", draft);
    expect(request.attributes).toContainEqual({ name: "DESTINATION", change: { kind: "set", value: "Host.With.Dots:1500" } });
    expect(request.attributes.some(({ name }) => name === "DESTINATION_NAME")).toBe(false);
    expect(request.finalEnabled).toBe(true);
    expect(original.snapshot.definition).toMatchObject({ value: { DESTINATION_OWNER: null, DESTINATION: "Host.With.Dots:1500" } });
  });
  it("rebases only acknowledged Scheduler creation and never resubmits creation-only flags as attributes", () => {
    const target = { scope, kind: "scheduler" as const, owner: "Owner", name: "Job" };
    const details = { snapshot: { ref: target, revision: "new", definition: { status: "available", value: { JOB_TYPE: "PLSQL_BLOCK", JOB_ACTION: "BEGIN NULL; END;", NUMBER_OF_ARGUMENTS: 0, AUTO_DROP: true } }, arguments: { status: "empty" } } } as NativeJobDetails;
    const draft = newNativeJobDefinitionDraft("scheduler");
    Object.assign(draft.attributes!, { ENABLED: { kind: "set", value: true }, JOB_PRIORITY: { kind: "set", value: 7 } });
    const status = { target, steps: [{ id: "create", state: "applied" }], outcome: "partial" } as NativeJobOperationStatus;
    const rebased = rebaseNativeJobDefinitionCreation(details, draft, status);
    expect(buildNativeJobEdit(details.snapshot, rebased).attributes).toEqual([
      { name: "START_DATE", change: draft.attributes!.START_DATE },
      { name: "JOB_PRIORITY", change: { kind: "set", value: 7 } },
    ]);
    expect(rebased.attributes).not.toHaveProperty("ENABLED");
    status.steps[0]!.state = "unknown";
    expect(rebaseNativeJobDefinitionCreation(details, draft, status)).toEqual({});
    expect(draft.attributes!.ENABLED).toEqual({ kind: "set", value: true });
    status.steps[0]!.state = "applied";
    Object.assign(draft.attributes!, { PROGRAM_NAME: { kind: "set", value: "Program" }, SCHEDULE_NAME: { kind: "set", value: "Schedule" } });
    const referenced = rebaseNativeJobDefinitionCreation(details, draft, status);
    for (const name of ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS", "START_DATE", "END_DATE", "REPEAT_INTERVAL"]) expect(referenced.attributes).not.toHaveProperty(name);
    expect(referenced.attributes!.JOB_PRIORITY).toEqual({ kind: "set", value: 7 });
  });
});
