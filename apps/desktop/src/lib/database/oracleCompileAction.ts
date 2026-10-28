import { buildOracleCompileErrorsSql, buildOracleCompileSql, formatOracleCompileErrors } from "./oracleCompileSql";

/**
 * The Oracle "Compile" action, as a driver-agnostic function.
 *
 * Oracle answers `ALTER <kind> <name> COMPILE` with success even when the object
 * is left INVALID: the diagnostics live in `ALL_ERRORS`, not in the DDL's own
 * result. A compile a user can trust is therefore two statements -- the compile,
 * then the read-back -- and this module decides between success and the error
 * report from the read-back.
 *
 * The statements themselves go through an injected `runQuery`, because the two
 * entry points (the object browser and the sidebar tree) execute SQL through
 * different channels: both wrap the DDL in the production-safety guard, while the
 * read-back is deliberately unguarded. Keeping that policy in the callers is what
 * makes this whole module a pure function that unit tests can drive with a fake
 * `runQuery` -- the same shape `oracleCompileSql.ts` already has for its builders.
 */

/** Which of the two statements the action is asking the caller to run. */
export type OracleCompileStage = "compile" | "errors";

/** One statement handed to the caller's query channel. */
export interface OracleCompileQueryRequest {
  connectionId: string;
  database: string;
  /** Execution schema of the statement (the object's owning schema). */
  schema: string | null;
  sql: string;
  /** `compile` for the DDL, `errors` for the ALL_ERRORS read-back. */
  stage: OracleCompileStage;
}

/** The only shape the action reads off a query result: the read-back's rows. */
export interface OracleCompileQueryResult {
  rows?: unknown;
}

/**
 * Runs one statement the action built and resolves with its result.
 *
 * Resolving `undefined` means the caller declined to execute it -- in both
 * components that is the production-safety guard refusing a write. The action
 * then reports `blocked` and stops, because claiming the compile succeeded
 * without having run it would be a lie.
 *
 * A rejection is a real failure and is reported as `failed` with the caller's own
 * message text, verbatim.
 */
export type OracleCompileRunQuery = (request: OracleCompileQueryRequest) => Promise<OracleCompileQueryResult | undefined | void>;

export interface OracleCompileActionInput {
  runQuery: OracleCompileRunQuery;
  connectionId: string;
  database: string;
  /** Schema the compile statement targets; also the default ALL_ERRORS owner. */
  schema?: string | null;
  /**
   * Owner the ALL_ERRORS read-back filters by. Defaults to `schema`; a caller
   * whose execution schema differs from the object's owner sets it explicitly.
   */
  owner?: string | null;
  name: string;
  /** Object kind in the tree's spelling (`PROCEDURE`, `package-body`, …). */
  objectType: string;
}

/**
 * Outcome of one Compile action.
 *
 *   - `unsupported`: the object kind is one Oracle cannot recompile -- the caller
 *     only ever reaches this through a stale menu entry, so it shows nothing.
 *   - `blocked`: the caller's channel declined to run a statement (production guard).
 *     The caller has already explained itself, so it shows nothing either.
 *   - `success`: the object compiled and ALL_ERRORS is empty.
 *   - `invalid`: the object compiled but ALL_ERRORS still names diagnostics; the
 *     `message` is `formatOracleCompileErrors`' rendering.
 *   - `failed`: one of the two statements threw; `message` is the exception's.
 */
export type OracleCompileOutcome =
  | { status: "unsupported" }
  | { status: "blocked"; sql: string; stage: OracleCompileStage }
  | { status: "success"; sql: string }
  | { status: "invalid"; sql: string; errorsSql: string | null; message: string }
  | { status: "failed"; sql: string; stage: OracleCompileStage; message: string };

/**
 * Recompiles one Oracle object and reports what `ALL_ERRORS` says afterwards.
 *
 * Never throws: every failure becomes an outcome, so the caller decides between a
 * toast and its error dialog and stays in charge of refreshing its own view.
 */
export async function runOracleCompileAction(input: OracleCompileActionInput): Promise<OracleCompileOutcome> {
  const sql = buildOracleCompileSql({ objectType: input.objectType, schema: input.schema ?? undefined, name: input.name });
  if (!sql) return { status: "unsupported" };

  const compileRequest: OracleCompileQueryRequest = {
    connectionId: input.connectionId,
    database: input.database,
    schema: input.schema ?? null,
    sql,
    stage: "compile",
  };
  let executed: OracleCompileQueryResult | undefined | void;
  try {
    executed = await input.runQuery(compileRequest);
  } catch (caught) {
    return { status: "failed", sql, stage: "compile", message: describeError(caught) };
  }
  if (executed === undefined) return { status: "blocked", sql, stage: "compile" };

  const owner = input.owner ?? input.schema ?? undefined;
  const errorsSql = buildOracleCompileErrorsSql({ schema: owner, name: input.name });
  // A blank name cannot reach here (the compile builder already rejected it), so
  // this is only defensive: without a read-back there is nothing to check, and the
  // compile's own answer is all the caller gets.
  if (!errorsSql) return { status: "success", sql };

  const errorsRequest: OracleCompileQueryRequest = {
    connectionId: input.connectionId,
    database: input.database,
    schema: input.schema ?? null,
    sql: errorsSql,
    stage: "errors",
  };
  let message: string;
  try {
    const errors = await input.runQuery(errorsRequest);
    // The read-back is what decides, so a declined read-back is not "success":
    // report it as blocked with the statement that was refused.
    if (errors === undefined) return { status: "blocked", sql: errorsSql, stage: "errors" };
    message = formatOracleCompileErrors(errors?.rows ?? []);
  } catch (caught) {
    return { status: "failed", sql: errorsSql, stage: "errors", message: describeError(caught) };
  }
  if (message) return { status: "invalid", sql, errorsSql, message };
  return { status: "success", sql };
}

/** The message the two entry points already put into their error dialog. */
function describeError(caught: unknown): string {
  const message = (caught as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : String(caught);
}
