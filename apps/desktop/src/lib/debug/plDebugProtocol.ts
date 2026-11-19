export interface PlDebugBootstrap {
  serverEpoch: string;
  heartbeatSeconds: number;
  leaseSeconds: number;
  cleanupSeconds: number;
}

export interface PlDebugSessionRef {
  serverEpoch: string;
  sessionId: string;
  connectionId: string;
  clientSessionId: string;
}

export interface PlDebugInspectRequest {
  connectionId: string;
  database: string;
  clientSessionId: string;
  target?: { schema?: string; objectType: "PROCEDURE" | "FUNCTION"; objectName: string; packageName?: string; metadataPreparation?: "type_only" | "debug_compile" };
}

export interface PlDebugArgument {
  name: string | null;
  position: number;
  sequence: number;
  dataLevel: number;
  mode: "IN" | "OUT" | "IN OUT";
  type: string;
  typeOwner: string | null;
  typeName: string | null;
  typeSubname: string | null;
  defaulted: string | null;
}

export interface PlDebugTargetSignature {
  schema: string;
  objectName: string;
  packageName: string | null;
  objectType: "PROCEDURE" | "FUNCTION";
  objectId: string;
  subprogramId: number;
  status: string | null;
  arguments: PlDebugArgument[];
  signatureVersion?: 2;
  metadataPreparation?: "type_only";
  nationalCharacterSet?: string;
  argumentDetails?: Array<Record<string, string | null>>;
  typeBindings?: Array<{
    sequence: number;
    reference: { owner: string; packageName: string | null; typeName: string };
  }>;
  typeGraph?: {
    nodes: Array<{
      reference: { owner: string; packageName: string | null; typeName: string };
      definition: Record<string, string | null>;
      attributes: Array<Record<string, string | null>>;
      collections: Array<Record<string, string | null>>;
      constructorCalls?: {
        state: string;
        constructors: Array<{ id: string; origin: string; parameters: Array<{ name: string; type: Record<string, string | null>; defaulted: boolean }> }>;
      };
      objectAccess?: { state: string; sqlState?: string | null; vendorCode?: number | null };
    }>;
    versions: Array<{
      reference: { owner: string; name: string };
      objects: Array<Record<string, string | null>>;
      source: Array<Record<string, string | null>>;
    }>;
  };
  targetVersion?: {
    objects: Array<Record<string, string | null>>;
    source: Array<Record<string, string | null>>;
  };
}

export interface PlDebugCompilePreview {
  schema: string;
  objectName: string;
  objectType: "PROCEDURE" | "FUNCTION" | "PACKAGE BODY";
  sql: string;
  reusesSettings: boolean;
  sources: Array<Record<string, unknown>>;
  signatures?: PlDebugTargetSignature[];
  settings?: { state: "ready" | "requires_compile" | "unknown"; plsqlDebug?: string | null; optimizeLevel?: string | null; reason?: string; vendorCode?: number };
  canCompile: boolean;
  state: "available" | "source_unavailable";
}

export interface PlDebugInspectResult {
  connectionRevision: string;
  capabilities: Record<string, unknown>;
  compilePreview?: PlDebugCompilePreview;
  compileObservation?: {
    schema: string;
    objectName: string;
    objectType: "PROCEDURE" | "FUNCTION" | "PACKAGE BODY";
    readback?: { status?: string; objectId?: string; diagnostics?: Array<Record<string, unknown>>; diagnosticsComplete?: boolean; diagnosticsError?: string; settings?: Record<string, unknown>; settingsError?: string };
    error?: string;
  };
  targetPreview?: {
    schema: string;
    state: "available" | "not_visible";
    message?: string;
    candidates: Array<{
      signature: PlDebugTargetSignature;
      parameters: PlDebugArgument[];
      returnValue: PlDebugArgument | null;
      parameterTransport: "implemented" | "not_implemented";
      message?: string;
    }>;
  };
}

export interface PlDebugCompileRef {
  serverEpoch: string;
  operationId: string;
  connectionId: string;
  clientSessionId: string;
}

export interface PlDebugCompileIntent extends PlDebugInspectRequest {
  serverEpoch: string;
  operationId: string;
  target: NonNullable<PlDebugInspectRequest["target"]>;
  preview: PlDebugCompilePreview;
  expectedConnectionRevision: string;
  confirmed: boolean;
  productionConfirmed: boolean;
}

export interface PlDebugCompileReceipt extends PlDebugCompileRef {
  target?: Pick<PlDebugCompilePreview, "schema" | "objectName" | "objectType">;
  dispatched: boolean;
  ddlState: "not_started" | "executed" | "failed" | "unknown";
  finished: boolean;
  releaseState: "released" | "unconfirmed";
  error: string | null;
  cleanupError: string | null;
  result: Record<string, unknown> | null;
}

export interface PlDebugStartIntent {
  serverEpoch: string;
  operationId: string;
  connectionId: string;
  database: string;
  clientSessionId: string;
  target: Record<string, unknown>;
  riskAccepted: boolean;
  productionConfirmed: boolean;
  expectedConnectionRevision?: string;
}

export type PlDebugAction = "resume" | "step_over" | "step_in" | "step_out" | "run_to_end" | "abort" | "close" | "restart" | "set_breakpoints" | "delete_breakpoints" | "set_breakpoint_enabled" | "set_exception_breakpoint" | "set_value" | "execute";

export interface PlDebugOperationRequest extends PlDebugSessionRef {
  operationId: string;
  expectedRevision: number;
  generation: number;
  action: PlDebugAction;
  params?: Record<string, unknown>;
  productionConfirmed?: boolean;
}

export interface PlDebugReadRequest extends PlDebugSessionRef {
  generation: number;
  stopRevision?: number | null;
  kind: "variables" | "value" | "stack" | "log" | "log_page" | "breakpoints" | "results" | "result_page";
  params?: Record<string, unknown>;
}

export interface PlDebugReceipt {
  serverEpoch: string;
  sessionId: string;
  operationId: string;
  generation: number;
  revision: number;
  state: "accepted" | "running" | "succeeded" | "failed" | "unknown";
  dispatched: boolean;
  result: unknown;
  error: Record<string, unknown> | null;
}

export interface PlDebugVariable {
  name: string;
  type?: string | null;
  state: "value" | "empty" | "null" | "out_of_scope" | "error" | "unknown";
  value: string | null;
  rawValue?: string | null;
  nativeResult?: number | null;
  message?: string | null;
}

export interface PlDebugValueContext extends PlDebugSessionRef {
  generation: number;
  stopRevision: number;
  frame: number;
  viewSerial: number;
}

export interface PlDebugSnapshot extends PlDebugSessionRef, Record<string, unknown> {
  startOperationId: string;
  database: string;
  generation: number;
  revision: number;
  state: "starting" | "paused" | "running" | "ended" | "unknown";
  executionOutcome: "not_started" | "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  releaseState: "open" | "releasing" | "released" | "unknown";
  transactionOutcome: string;
  runtimeExited: boolean;
  closing: boolean;
  activeOperationId: string | null;
  recovery?: {
    version: 1;
    closeOperationId: string | null;
    operations: Array<{ operationId: string; action: PlDebugAction; requestGeneration: number; receiptGeneration: number; state: "accepted" | "running" | "unknown" }>;
  };
  stopRevision?: number | null;
  executionStopped?: boolean;
  startState?: "pending" | "succeeded" | "failed";
  target: Record<string, unknown>;
}
