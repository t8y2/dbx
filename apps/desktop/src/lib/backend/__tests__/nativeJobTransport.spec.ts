import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "../http";
import * as tauri from "../tauri";
import * as api from "../api";
import type { NativeJobRequest, NativeJobValue } from "../../database/nativeJobs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

const scope = { connectionId: "connection a", database: "Owner.With.Dot", contextId: "bound-context" };
const target = { kind: "scheduler" as const, scope, owner: "Exact Owner", name: " Job,\"One's " };
const list = { scope, kind: "scheduler" as const, schema: "Exact Owner", filter: "%not-a-wildcard_", offset: 500, limit: 100 };
const mutation = { action: "update" as const, target, baseline: "bound-revision", attributes: [{ name: "COMMENTS", change: { kind: "set" as const, value: "literal 'comment'" } }], arguments: [] };
const cases = [
  { name: "nativeJobOpenContext", command: "native_job_open_context", route: "context", args: [scope.connectionId, scope.database], invoke: { connectionId: scope.connectionId, database: scope.database }, body: { connectionId: scope.connectionId, database: scope.database } },
  { name: "nativeJobList", command: "native_job_list", route: "list", args: [list], invoke: { request: list }, body: list },
  { name: "nativeJobReferences", command: "native_job_references", route: "references", args: [{ ...list, kind: "program", name: 'Program,"Exact' }], invoke: { request: { ...list, kind: "program", name: 'Program,"Exact' } }, body: { ...list, kind: "program", name: 'Program,"Exact' } },
  { name: "nativeJobRead", command: "native_job_read", route: "read", args: [target], invoke: { target }, body: target },
  { name: "nativeJobPrepare", command: "native_job_prepare", route: "prepare", args: [mutation], invoke: { mutation }, body: mutation },
  { name: "nativeJobApply", command: "native_job_apply", route: "apply", args: ["immutable-plan"], invoke: { planId: "immutable-plan" }, body: { planId: "immutable-plan" } },
  { name: "nativeJobStatus", command: "native_job_status", route: "status", args: ["operation-id"], invoke: { operationId: "operation-id" }, body: { operationId: "operation-id" } },
  { name: "nativeJobCancel", command: "native_job_cancel", route: "cancel", args: ["operation-id"], invoke: { operationId: "operation-id" }, body: { operationId: "operation-id" } },
] as const;

describe("native Job dual transport", () => {
  const fetch = vi.fn();
  const response = { operationId: "operation-id", target, state: "finished", outcome: "unknown", cancelRequested: true, steps: [], reason: "native_job_execution_outcome_unknown" };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetch);
    fetch.mockImplementation(async () => new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } }));
    invoke.mockResolvedValue(response);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(cases)("$name preserves the exact target and shared response through both real adapters", async (operation) => {
    expect(await Reflect.apply(tauri[operation.name], undefined, operation.args)).toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(operation.command, operation.invoke);
    expect(await Reflect.apply(http[operation.name], undefined, operation.args)).toEqual(response);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url), "http://localhost").pathname).toBe(`/api/schema/native-jobs/${operation.route}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(operation.body);
    expect(await Reflect.apply(api[operation.name], undefined, operation.args)).toEqual(response);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an apply whose transport response was lost", async () => {
    fetch.mockRejectedValue(new TypeError("network response lost"));
    await expect(http.nativeJobApply("immutable-plan")).rejects.toThrow("network response lost");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("transports typed scalar, civil-date and typed-NULL payloads without stringification or numeric coercion", async () => {
    const values: NativeJobValue[] = [
      '{"$dbx":"oracle-anydata-v1","scalarType":"number","value":"1"}',
      ...["varchar2", "char", "nvarchar2", "nchar"].map((scalarType) => ({ $dbx: "oracle-anydata-v1", scalarType, value: "引号'\\😀  " })),
      { $dbx: "oracle-anydata-v1", scalarType: "number", value: "9007199254740993.123456789" },
      { $dbx: "oracle-anydata-v1", scalarType: "char", value: null },
      { $dbx: "oracle-anydata-v1", scalarType: "timestamp-tz", value: { civilDate: "-0001-12-31", seconds: "86399.123456789", region: "America/New_York", offset: "-04:00", abbreviation: "EDT" } },
      { $dbx: "oracle-anydata-v1", scalarType: "interval-ds", value: "-86399999999999999999999" },
      { $dbx: "oracle-anydata-v1", scalarType: "binary-double", value: "3FF0000000000001" },
      { $dbx: "oracle-anydata-v1", scalarType: "raw", value: "00FF0000" },
    ];
    const request: NativeJobRequest = { ...mutation, arguments: values.map((value, index) => ({ position: index + 1, value: { kind: "value", value } })) };
    await tauri.nativeJobPrepare(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_prepare", { mutation: request });
    await http.nativeJobPrepare(request);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  });

  it.each(["window", "window-group", "file-watcher", "destination-group"] as const)("preserves the %s reference category through both transports", async (kind) => {
    const request = { scope, kind, schema: 'Exact.Owner"', name: "Named,Reference.One", filter: "", offset: 0, limit: 1 };
    const catalog = { objects: { status: "available", value: [{ DBX_OWNER: request.schema, DBX_NAME: request.name }] }, source: { source: "native-reference", coverage: "accessible" }, offset: 0, limit: 1 };
    invoke.mockResolvedValue(catalog);
    fetch.mockResolvedValue(new Response(JSON.stringify(catalog), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobReferences(request)).toEqual(catalog);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_references", { request });
    expect(await http.nativeJobReferences(request)).toEqual(catalog);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
  });

  it.each([false, true])("keeps final enabled intent %s with exact reference components in both previews", async (finalEnabled) => {
    const request: NativeJobRequest = {
      ...mutation,
      finalEnabled,
      attributes: [{ name: "PROGRAM_NAME", change: { kind: "set", value: { owner: 'Other.Owner"', name: "Program,A.B", kind: "program" } } }],
      argumentTarget: { program: { owner: 'Other.Owner"', name: "Program,A.B" }, arguments: [{ position: 1, dataType: "NUMBER", value: { kind: "null" } }] },
    };
    const plan = { planId: "plan", operationId: "operation", scope, target, steps: [] };
    invoke.mockResolvedValue(plan);
    fetch.mockResolvedValue(new Response(JSON.stringify(plan), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobPrepare(request)).toEqual(plan);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_prepare", { mutation: request });
    expect(await http.nativeJobPrepare(request)).toEqual(plan);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(mutation).not.toHaveProperty("finalEnabled");
  });

  it("previews a new legacy Job without inventing a numeric ID or changing its scope", async () => {
    const request = { action: "create" as const, scope, definition: { kind: "legacy" as const, what: "private_call('x');", nextDate: "2026-10-21 10:20:30", interval: "NULL", enabled: false, schema: "Exact Owner" } };
    const plan = { planId: "plan", operationId: "operation", scope, target: null, steps: [] };
    invoke.mockResolvedValue(plan);
    fetch.mockResolvedValue(new Response(JSON.stringify(plan), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobPrepare(request)).toEqual(plan);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_prepare", { mutation: request });
    expect(await http.nativeJobPrepare(request)).toEqual(plan);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("target");
  });

  it("opts into native observation using only the operation ID and preserves exact instance keys", async () => {
    const result = {
      ...response,
      outcome: "accepted",
      executionObservation: {
        observedAt: "2026-10-21T12:00:00Z",
        association: "uncertain",
        reason: "native_job_observation_request_uncertain",
        running: { status: "empty" },
        history: { status: "available", value: [{ LOG_ID: "900719925474099312345", STATUS: "FAILED" }] },
        sources: {},
        candidates: [{ nativeKey: "900719925474099312345", phase: "history", evidence: "new-history", row: { LOG_ID: "900719925474099312345", STATUS: "FAILED" } }],
      },
    };
    invoke.mockResolvedValue(result);
    fetch.mockResolvedValue(new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobStatus("operation", true)).toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_status", { operationId: "operation", observe: true });
    expect(await http.nativeJobStatus("operation", true)).toEqual(result);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ operationId: "operation", observe: true });
  });

  it("preserves Scheduler references and observed native generations without numeric coercion", async () => {
    const request = {
      action: "create" as const,
      scope,
      definition: {
        kind: "scheduler" as const,
        owner: target.owner,
        name: target.name,
        program: { owner: "Other.Owner", name: 'Program,"Name' },
        schedule: { owner: "CalendarOwner", name: "Calendar.Name" },
        numberOfArguments: 0,
        enabled: false,
        autoDrop: false,
        arguments: [{ position: 1, dataType: "VARCHAR2", value: { kind: "inherit" as const } }],
      },
    };
    const plan = { planId: "scheduler-plan", operationId: "scheduler-operation", scope, target, steps: [] };
    const result = { ...response, observedIdentity: { DBX_JOB_ID: "900719925474099312345", DBX_CREATED_AT: "exact generation" } };
    invoke.mockImplementation(async (command: string) => (command === "native_job_prepare" ? plan : result));
    fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/prepare") ? plan : result), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobPrepare(request)).toEqual(plan);
    expect(await http.nativeJobPrepare(request)).toEqual(plan);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(await tauri.nativeJobStatus("operation-id")).toEqual(result);
    expect(await http.nativeJobStatus("operation-id")).toEqual(result);
  });

  it("preserves Dameng child edits and explicit native command input through both transports", async () => {
    const request: NativeJobRequest = {
      action: "configure-dameng",
      target: { kind: "dameng-native", scope, jobId: "900719925474099312345", name: "Job_1" },
      baseline: "native-baseline",
      configuration: {
        attributes: [{ name: "ENABLE", change: { kind: "set", value: false } }],
        steps: [
          {
            kind: "update",
            name: "backup",
            attributes: [
              { name: "COMMAND_INPUT", change: { kind: "set", value: "01000000E:\\backups" } },
              { name: "SUCC_NEXT_STEP", change: { kind: "clear" } },
            ],
          },
        ],
        schedules: [
          { kind: "add", name: "new_schedule" },
          { kind: "drop", name: "old_schedule" },
        ],
      },
    };
    expect(await tauri.nativeJobPrepare(request)).toEqual(response);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_job_prepare", { mutation: request });
    expect(await http.nativeJobPrepare(request)).toEqual(response);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(await api.nativeJobPrepare(request)).toEqual(response);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(request);
  });

  it("keeps native Dameng creation targetless and returns acknowledged child IDs as exact strings", async () => {
    const request: NativeJobRequest = { action: "create", scope, definition: { kind: "dameng-native", name: "New_job", enabled: false, configuration: { steps: [{ kind: "add", name: "sql", attributes: [{ name: "COMMAND_INPUT", change: { kind: "set", value: "SELECT 1;" } }] }] } } };
    const plan = { planId: "native-create", operationId: "operation", scope, target: null, steps: [] };
    const result = { ...response, createdChildren: [{ partition: "steps", name: "sql", id: "900719925474099312345" }] };
    invoke.mockImplementation(async (command: string) => (command === "native_job_prepare" ? plan : result));
    fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/prepare") ? plan : result), { headers: { "Content-Type": "application/json" } }));
    expect(await tauri.nativeJobPrepare(request)).toEqual(plan);
    expect(await http.nativeJobPrepare(request)).toEqual(plan);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(await tauri.nativeJobStatus("operation")).toEqual(result);
    expect(await http.nativeJobStatus("operation")).toEqual(result);
  });
});
