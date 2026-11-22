import { describe, expect, it } from "vitest";
import {
  buildPostgresSequenceAlterSql,
  buildPostgresSequenceMetadataSql,
  buildPostgresSequenceStateSql,
  buildPostgresSequenceVersionSql,
  parsePostgresSequenceMetadata,
  parsePostgresSequenceState,
  parsePostgresSequenceVersion,
  PostgresSequenceValidationError,
  type PostgresSequenceDraft,
  type PostgresSequenceErrorCode,
  type PostgresSequenceParameters,
} from "../postgresSequence";

const identity = { schema: "public", name: "orders_id_seq" };
const parameters: PostgresSequenceParameters = {
  dataType: "bigint",
  startValue: "1",
  minValue: "1",
  maxValue: "9223372036854775807",
  increment: "1",
  cacheSize: "1",
  cycle: false,
};
function draft(overrides: Partial<PostgresSequenceDraft> = {}): PostgresSequenceDraft {
  return { ...parameters, restartWith: "", ...overrides };
}
function result(values: Record<string, unknown>) {
  return { columns: Object.keys(values), rows: [Object.values(values)] };
}
function metadata(overrides: Record<string, unknown> = {}) {
  return result({ oid: "12345", sequence_schema: "public", sequence_name: "orders_id_seq", data_type: "bigint", start_value: "1", min_value: "1", max_value: "9223372036854775807", increment: "1", cache_size: "1", cycle: false, can_read_state: true, can_alter: true, ...overrides });
}
function expectCode(operation: () => unknown, code: PostgresSequenceErrorCode, field?: string) {
  try {
    operation();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PostgresSequenceValidationError);
    expect(error).toMatchObject({ code, ...(field ? { field } : {}) });
  }
}

describe("PostgreSQL sequence inspection", () => {
  it("requires PostgreSQL 10 or newer before reading pg_sequence", () => {
    expect(buildPostgresSequenceVersionSql()).toContain("current_setting('server_version_num')::text");
    for (const version of ["100000", "160002", "190000"]) expect(parsePostgresSequenceVersion(result({ server_version_num: version }))).toBe(Number(version));
    for (const version of ["90624", "9.6.24", "16.2", "100000; SELECT 1", "9999999999", 160002]) {
      expectCode(() => parsePostgresSequenceVersion(result({ server_version_num: version })), "unsupportedVersion");
    }
  });

  it("reads parameters and privileges without advancing the sequence", () => {
    const sql = buildPostgresSequenceMetadataSql(identity);
    expect(sql).toContain("FROM pg_catalog.pg_sequence s");
    expect(sql).toContain("c.relkind = 'S'");
    expect(sql).toContain("n.nspname = E'public' AND c.relname = E'orders_id_seq'");
    expect(sql).toContain("has_sequence_privilege(c.oid, 'SELECT')");
    expect(sql).toContain("pg_has_role(c.relowner, 'USAGE')");
    for (const field of ["seqstart", "seqmin", "seqmax", "seqincrement", "seqcache"]) expect(sql).toContain(`s.${field}::text`);
    expect(sql).not.toMatch(/\b(?:nextval|setval|currval)\s*\(/i);
    expect(buildPostgresSequenceStateSql(identity)).toBe('SELECT last_value::text AS last_value, is_called FROM "public"."orders_id_seq";');
  });

  it("quotes exact identifier names and escapes lookup literals independently of string settings", () => {
    const unusual = { schema: `库'\\".owner`, name: `Seq"; DROP TABLE x; --` };
    expect(buildPostgresSequenceStateSql(unusual)).toBe('SELECT last_value::text AS last_value, is_called FROM "库\'\\"".owner"."Seq""; DROP TABLE x; --";');
    const sql = buildPostgresSequenceMetadataSql(unusual);
    expect(sql).toContain("n.nspname = E'库''\\\\\".owner'");
    expect(sql).toContain("c.relname = E'Seq\"; DROP TABLE x; --'");
    expectCode(() => buildPostgresSequenceStateSql({ schema: "", name: "seq" }), "invalidIdentity");
    expectCode(() => buildPostgresSequenceMetadataSql({ schema: "public", name: "seq\0other" }), "invalidIdentity");
  });

  it("preserves exact bigint values and distinguishes false privileges", () => {
    const parsed = parsePostgresSequenceMetadata(metadata({ start_value: "9007199254740993", can_read_state: "f", can_alter: "false" }));
    expect(parsed).toMatchObject({ ...identity, oid: "12345", startValue: "9007199254740993", maxValue: "9223372036854775807", canReadState: false, canAlter: false });
  });

  it("preserves never-called state without guessing a next value", () => {
    const state = parsePostgresSequenceState(result({ last_value: "9223372036854775807", is_called: false }));
    expect(state).toEqual({ lastValue: "9223372036854775807", isCalled: false });
    expect(parsePostgresSequenceState(result({ last_value: "-9223372036854775808", is_called: "t" }))).toEqual({ lastValue: "-9223372036854775808", isCalled: true });
  });

  it("rejects absent objects, duplicate rows and incomplete or lossy metadata", () => {
    expectCode(() => parsePostgresSequenceMetadata({ columns: [], rows: [] }), "missingSequence");
    const duplicated = metadata();
    duplicated.rows.push(duplicated.rows[0]!);
    expectCode(() => parsePostgresSequenceMetadata(duplicated), "invalidMetadata");
    expectCode(() => parsePostgresSequenceMetadata(metadata({ max_value: Number("9223372036854775807") })), "invalidMetadata", "max_value");
    expectCode(() => parsePostgresSequenceMetadata(metadata({ can_alter: null })), "invalidMetadata", "can_alter");
    expectCode(() => parsePostgresSequenceMetadata(metadata({ oid: "4294967296" })), "invalidMetadata", "oid");
    expectCode(() => parsePostgresSequenceMetadata(metadata({ data_type: "numeric" })), "unsupportedDataType");
    expectCode(() => parsePostgresSequenceState(result({ last_value: 9007199254740992, is_called: true })), "invalidState", "last_value");
    expectCode(() => parsePostgresSequenceState(result({ last_value: "1", is_called: null })), "invalidState", "is_called");
  });
});

describe("PostgreSQL sequence ALTER planning", () => {
  it("returns no SQL for an unchanged draft, including alternate decimal spellings", () => {
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft())).toBeNull();
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft({ startValue: " +0001 ", cacheSize: "01", restartWith: " " }))).toBeNull();
  });

  it("changes only requested parameters and never resets sequence state implicitly", () => {
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft({ maxValue: "9007199254740993", cacheSize: "20", cycle: true }))).toBe('ALTER SEQUENCE "public"."orders_id_seq"\n  MAXVALUE 9007199254740993\n  CACHE 20\n  CYCLE;');
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft({ startValue: "50" }))).toBe('ALTER SEQUENCE "public"."orders_id_seq"\n  START WITH 50;');
  });

  it("uses one transactional ALTER for explicitly requested restart and parameter changes", () => {
    const sql = buildPostgresSequenceAlterSql({ schema: 'Case"Schema', name: 'Seq"Name' }, parameters, draft({ increment: "2", startValue: "10", restartWith: "9007199254740993" }));
    expect(sql).toBe('ALTER SEQUENCE "Case""Schema"."Seq""Name"\n  INCREMENT BY 2\n  START WITH 10\n  RESTART WITH 9007199254740993;');
    expect(sql).not.toContain("setval");
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft({ restartWith: "1" }))).toContain("RESTART WITH 1");
  });

  it("supports descending sequences and both bigint endpoints without Number conversion", () => {
    const descending: PostgresSequenceParameters = { ...parameters, startValue: "-1", minValue: "-9223372036854775808", maxValue: "-1", increment: "-1", cycle: true };
    expect(buildPostgresSequenceAlterSql(identity, descending, { ...descending, cycle: false, restartWith: "-9223372036854775808" })).toBe('ALTER SEQUENCE "public"."orders_id_seq"\n  NO CYCLE\n  RESTART WITH -9223372036854775808;');
    expect(buildPostgresSequenceAlterSql(identity, parameters, draft({ restartWith: "9223372036854775807" }))).toContain("RESTART WITH 9223372036854775807");
  });

  it.each(["1; DROP TABLE users", "1e3", "1.5", "0x10", "NaN", "Infinity", "", "--1", "1_000"])("rejects non-decimal numeric input %j", (input) => {
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ increment: input })), "invalidInteger", "increment");
  });

  it.each(["9223372036854775808", "-9223372036854775809", "123456789012345678901234567890"])("rejects out-of-bigint-range input %j", (input) => {
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ increment: input })), "outOfRange", "increment");
  });

  it("validates range, start, restart, nonzero increment and positive cache together", () => {
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ increment: "-0" })), "invalidIncrement", "increment");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ cacheSize: "0" })), "invalidCacheSize", "cacheSize");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ cacheSize: "-1" })), "invalidCacheSize", "cacheSize");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ minValue: "5", maxValue: "5" })), "invalidBounds");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ minValue: "10" })), "invalidStartValue", "startValue");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ restartWith: "0" })), "invalidRestartValue", "restartWith");
    expectCode(() => buildPostgresSequenceAlterSql(identity, parameters, draft({ maxValue: "10", restartWith: "11" })), "invalidRestartValue", "restartWith");
  });

  it.each([
    ["smallint", "-32768", "32767", "32768"],
    ["integer", "-2147483648", "2147483647", "2147483648"],
  ] as const)("respects %s sequence bounds", (dataType, minValue, maxValue, overflow) => {
    const typed = { ...parameters, dataType, minValue, maxValue };
    expect(buildPostgresSequenceAlterSql(identity, typed, { ...typed, restartWith: minValue })).toContain(`RESTART WITH ${minValue}`);
    expect(buildPostgresSequenceAlterSql(identity, typed, { ...typed, restartWith: maxValue })).toContain(`RESTART WITH ${maxValue}`);
    expectCode(() => buildPostgresSequenceAlterSql(identity, typed, { ...typed, maxValue: overflow, restartWith: "" }), "outOfRange", "maxValue");
  });
});
