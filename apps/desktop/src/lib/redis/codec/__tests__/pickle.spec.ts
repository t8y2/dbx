import { describe, expect, it } from "vitest";
import { decodePickle, isPickleMagic } from "../pickle";

function blob(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

describe("decodePickle", () => {
  it("rejects non-pickle payloads", () => {
    expect(isPickleMagic(new Uint8Array([0x7b, 0x7d]))).toBe(false);
    expect(decodePickle(new TextEncoder().encode("not pickle"))).toBeNull();
    expect(decodePickle(new Uint8Array(0))).toBeNull();
  });

  it("decodes a Celery SUCCESS result from protocol 4", () => {
    const detail = decodePickle(blob("gASViwAAAAAAAAB9lCiMBnN0YXR1c5SMB1NVQ0NFU1OUjAZyZXN1bHSUfZQojAR0YXNrlIwDYWRklIwFdmFsdWWUSwN1jAl0cmFjZWJhY2uUTowIY2hpbGRyZW6UXZSMCWRhdGVfZG9uZZSMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfoBhgMAAAAAACUhZRSlHUu"));
    expect(detail).not.toBeNull();
    expect(detail?.value).toEqual({
      status: "SUCCESS",
      result: { task: "add", value: 3 },
      traceback: null,
      children: [],
      date_done: "2024-06-24T12:00:00",
    });
  });

  it("decodes the same Celery result from protocol 2", () => {
    const detail = decodePickle(
      blob(
        "gAJ9cQAoWAYAAABzdGF0dXNxAVgHAAAAU1VDQ0VTU3ECWAYAAAByZXN1bHRxA31xBChYBAAAAHRhc2txBVgDAAAAYWRkcQZYBQAAAHZhbHVlcQdLA3VYCQAAAHRyYWNlYmFja3EITlgIAAAAY2hpbGRyZW5xCV1xClgJAAAAZGF0ZV9kb25lcQtjZGF0ZXRpbWUKZGF0ZXRpbWUKcQxjX2NvZGVjcwplbmNvZGUKcQ1YCwAAAAfDqAYYDAAAAAAAcQ5YBgAAAGxhdGluMXEPhnEQUnERhXESUnETdS4=",
      ),
    );
    expect(detail?.value).toEqual({
      status: "SUCCESS",
      result: { task: "add", value: 3 },
      traceback: null,
      children: [],
      date_done: "2024-06-24T12:00:00",
    });
  });

  it.each([
    [0, "KGRwMApWc3RhdHVzCnAxClZTVUNDRVNTCnAyCnNWcmVzdWx0CnAzCihscDQKSTEKYVZoZWxsbwpwNQphTmFJMDEKYUkwMAphcy4="],
    [1, "fXEAKFgGAAAAc3RhdHVzcQFYBwAAAFNVQ0NFU1NxAlgGAAAAcmVzdWx0cQNdcQQoSwFYBQAAAGhlbGxvcQVOSTAxCkkwMApldS4="],
  ])("explicitly decodes protocol %i without relaxing magic detection", (_protocol, fixture) => {
    const bytes = blob(fixture);

    expect(isPickleMagic(bytes)).toBe(false);
    expect(decodePickle(bytes)?.value).toEqual({
      status: "SUCCESS",
      result: [1, "hello", null, true, false],
    });
  });

  it("decodes nested tuples, lists, and dicts", () => {
    expect(decodePickle(blob("gASVIwAAAAAAAAB9lCiMBGFyZ3OUSwFLAoaUjAZrd2FyZ3OUfZSMAXiUiHN1Lg=="))?.value).toEqual({
      args: [1, 2],
      kwargs: { x: true },
    });
    expect(decodePickle(blob("gASVEgAAAAAAAABdlChLAYwFaGVsbG+UToiJZS4="))?.value).toEqual([1, "hello", null, true, false]);
  });

  it("decodes uuid and text scalars", () => {
    expect(decodePickle(blob("gASVEQAAAAAAAACMDWNlbGVyeS1yZXN1bHSULg=="))?.value).toBe("celery-result");
    expect(decodePickle(blob("gASVMAAAAAAAAACMBHV1aWSUjARVVUlElJOUKYGUfZSMA2ludJSKEHhWNBJ4VjQSeFY0EnhWNBJzYi4="))?.value).toBe("12345678-1234-5678-1234-567812345678");
  });

  it("does not execute GLOBAL callables; unknown classes stay as data", () => {
    expect(decodePickle(blob("gASVHwAAAAAAAACMCGJ1aWx0aW5zlIwEZXZhbJSTlIwDMSsxlIWUUpQu"))?.value).toEqual({
      $class: "builtins.eval",
      $args: ["1+1"],
    });
    expect(decodePickle(blob("gASVHQAAAAAAAACMCGJ1aWx0aW5zlIwDYWJzlJOUSv3///+FlFKULg=="))?.value).toEqual({
      $class: "builtins.abs",
      $args: [-3],
    });
  });
});
