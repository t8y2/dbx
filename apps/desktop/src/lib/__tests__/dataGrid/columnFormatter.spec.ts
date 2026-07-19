import { describe, expect, it } from "vitest";
import { normalizeSupportedDateTimePattern } from "@/lib/dataGrid/columnFormatter";

describe("normalizeSupportedDateTimePattern", () => {
  it("accepts the format grammar shared by the frontend and backend", () => {
    expect(normalizeSupportedDateTimePattern(" YYYY/M/D [at] HH:mm:ss.SSSZ ")).toBe("YYYY/M/D [at] HH:mm:ss.SSSZ");
  });

  it("rejects unsupported or malformed Day.js tokens", () => {
    expect(normalizeSupportedDateTimePattern("MM/DD/YYYY hh:mm A")).toBe("");
    expect(normalizeSupportedDateTimePattern("YYYY-MM-DD [at HH:mm:ss")).toBe("");
    expect(normalizeSupportedDateTimePattern("%Y-%m-%d")).toBe("");
  });
});
