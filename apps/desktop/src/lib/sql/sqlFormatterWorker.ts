import type { QueryEditorFormatSelection } from "@/lib/editor/queryEditorFormatSelection";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import type { SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";
import type { DataGripDialect, DataGripFormatMetrics } from "@/lib/sql/datagrip";

interface FormatterRequestBase {
  requestId: number;
  ownerId: string;
  sql: string;
  dialect: DataGripDialect;
}

interface FormatterFormatRequest extends FormatterRequestBase {
  kind: "format";
  settings: SqlFormatterSettings;
}

interface FormatterSelectionRequest extends FormatterRequestBase {
  kind: "mapSelection";
  formatted: string;
  selection: QueryEditorFormatSelection;
}

type FormatterWorkerRequest = FormatterFormatRequest | FormatterSelectionRequest;

type FormatterWorkerInput = Omit<FormatterFormatRequest, "requestId"> | Omit<FormatterSelectionRequest, "requestId">;

interface FormatterSuccess {
  requestId: number;
  formatted?: string;
  selection?: QueryEditorFormatSelection;
  metrics?: DataGripFormatMetrics;
}

interface FormatterFailure {
  requestId: number;
  error: {
    message: string;
    parseError: boolean;
  };
}

interface PendingRequest {
  request: FormatterWorkerRequest;
  resolve: (value: string | QueryEditorFormatSelection) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SqlFormatterWorkerError extends Error {
  constructor(
    message: string,
    readonly parseError = false,
  ) {
    super(message);
    this.name = "SqlFormatterWorkerError";
  }
}

export class SqlFormatterWorkerTimeoutError extends SqlFormatterWorkerError {
  constructor() {
    super("DataGrip SQL formatting timed out; the original SQL was left unchanged.");
    this.name = "SqlFormatterWorkerTimeoutError";
  }
}

export class SqlFormatterWorkerUnavailableError extends SqlFormatterWorkerError {
  constructor() {
    super("DataGrip SQL formatting requires Web Worker support.");
    this.name = "SqlFormatterWorkerUnavailableError";
  }
}

const DEFAULT_FORMAT_TIMEOUT_MS = 10_000;
let worker: Worker | null = null;
let active: PendingRequest | null = null;
const queued = new Map<string, PendingRequest>();
let nextRequestId = 0;
let automaticOwnerId = 0;

function supportedDialect(dialect: SqlFormatDialect): DataGripDialect {
  if (dialect === "postgres" || dialect === "mysql" || dialect === "sqlite") return dialect;
  throw new SqlFormatterWorkerError(`DataGrip formatting does not support the ${dialect} dialect.`);
}

function createWorker(): Worker {
  return new Worker(new URL("./sqlFormatter.worker.ts", import.meta.url), { type: "module" });
}
function cancellationValue(request: FormatterWorkerRequest): string | QueryEditorFormatSelection {
  return request.kind === "format" ? request.sql : request.selection;
}

function removePending(pending: PendingRequest): void {
  clearTimeout(pending.timeout);
  queued.delete(pending.request.ownerId);
}

function startNext(): void {
  if (active) return;
  const next = queued.values().next().value as PendingRequest | undefined;
  if (!next) return;
  queued.delete(next.request.ownerId);
  start(next);
}

function finishActive(result: string | QueryEditorFormatSelection): void {
  const current = active;
  active = null;
  if (current) {
    clearTimeout(current.timeout);
    current.resolve(result);
  }
  startNext();
}

function failActive(error: Error, restart = true): void {
  const current = active;
  active = null;
  if (current) {
    clearTimeout(current.timeout);
    current.reject(error);
  }
  if (restart) {
    worker?.terminate();
    worker = null;
  }
  startNext();
}

function start(pending: PendingRequest): void {
  if (typeof Worker === "undefined") {
    pending.reject(new SqlFormatterWorkerUnavailableError());
    startNext();
    return;
  }
  active = pending;
  try {
    worker ??= createWorker();
    const currentWorker = worker;
    worker.onmessage = (event: MessageEvent<FormatterSuccess | FormatterFailure>) => {
      if (worker !== currentWorker) return;
      if (!active || event.data.requestId !== active.request.requestId) return;
      if ("error" in event.data) failActive(new SqlFormatterWorkerError(event.data.error.message, event.data.error.parseError));
      else if (active.request.kind === "mapSelection") {
        if (!event.data.selection) failActive(new SqlFormatterWorkerError("The formatter Worker returned no selection mapping."));
        else finishActive(event.data.selection);
      } else if (typeof event.data.formatted !== "string") failActive(new SqlFormatterWorkerError("The formatter Worker returned no SQL text."));
      else finishActive(event.data.formatted);
    };
    worker.onerror = worker.onmessageerror = () => {
      if (worker === currentWorker) failActive(new SqlFormatterWorkerError("The formatter Worker failed unexpectedly."));
    };
    worker.postMessage(pending.request);
  } catch {
    failActive(new SqlFormatterWorkerUnavailableError());
  }
}

function schedule(request: FormatterWorkerInput): Promise<string | QueryEditorFormatSelection> {
  const requestWithId = { ...request, requestId: ++nextRequestId } as FormatterWorkerRequest;
  return new Promise((resolve, reject) => {
    const pending: PendingRequest = {
      request: requestWithId,
      resolve,
      reject,
      timeout: setTimeout(() => {
        if (active === pending) failActive(new SqlFormatterWorkerTimeoutError());
        else {
          removePending(pending);
          pending.reject(new SqlFormatterWorkerTimeoutError());
        }
      }, DEFAULT_FORMAT_TIMEOUT_MS),
    };
    const previousQueued = queued.get(request.ownerId);
    if (previousQueued) {
      removePending(previousQueued);
      previousQueued.resolve(cancellationValue(previousQueued.request));
    }
    if (active?.request.ownerId === request.ownerId) {
      const previous = active;
      worker?.terminate();
      worker = null;
      active = null;
      clearTimeout(previous.timeout);
      previous.resolve(cancellationValue(previous.request));
      startNext();
    }
    queued.set(request.ownerId, pending);
    startNext();
  });
}

export async function formatDataGripSqlUsingWorker(sql: string, dialect: SqlFormatDialect, settings: SqlFormatterSettings, ownerId?: string): Promise<string> {
  const owner = ownerId ?? `automatic-format-${++automaticOwnerId}`;
  return (await schedule({ kind: "format", ownerId: owner, sql, dialect: supportedDialect(dialect), settings })) as string;
}

export async function mapDataGripSelectionUsingWorker(source: string, formatted: string, selection: QueryEditorFormatSelection, dialect: SqlFormatDialect, ownerId?: string): Promise<QueryEditorFormatSelection> {
  const owner = ownerId ?? `automatic-selection-${++automaticOwnerId}`;
  return (await schedule({ kind: "mapSelection", ownerId: owner, sql: source, formatted, selection, dialect: supportedDialect(dialect) })) as QueryEditorFormatSelection;
}

export function cancelDataGripFormatterOwner(ownerId: string): void {
  const pending = queued.get(ownerId);
  if (pending) {
    removePending(pending);
    pending.resolve(cancellationValue(pending.request));
  }
  if (active?.request.ownerId === ownerId) {
    const previous = active;
    worker?.terminate();
    worker = null;
    active = null;
    clearTimeout(previous.timeout);
    previous.resolve(cancellationValue(previous.request));
    startNext();
  }
}

export function disposeDataGripFormatterWorker(): void {
  worker?.terminate();
  worker = null;
  if (active) {
    clearTimeout(active.timeout);
    active.resolve(cancellationValue(active.request));
    active = null;
  }
  for (const pending of queued.values()) {
    clearTimeout(pending.timeout);
    pending.resolve(cancellationValue(pending.request));
  }
  queued.clear();
}
