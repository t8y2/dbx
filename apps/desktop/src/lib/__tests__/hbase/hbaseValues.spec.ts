import { describe, expect, it } from "vitest";

import { encodeHBaseTextInput, hbaseCellInput } from "@/lib/hbase/hbaseValues";

describe("HBase value conversion", () => {
  it("keeps UTF-8 input unchanged", () => {
    expect(encodeHBaseTextInput("customer#001")).toEqual({ value: "customer#001", encoding: "utf8" });
    expect(hbaseCellInput("profile:name", "Alice")).toEqual({
      column: "profile:name",
      value: "Alice",
      valueEncoding: "utf8",
    });
  });

  it("removes the display prefix before sending Base64 input", () => {
    expect(encodeHBaseTextInput("base64:AAEC")).toEqual({ value: "AAEC", encoding: "base64" });
    expect(hbaseCellInput("profile:avatar", "base64:AP8=")).toEqual({
      column: "profile:avatar",
      value: "AP8=",
      valueEncoding: "base64",
    });
  });

  it("writes null cells as empty UTF-8 values", () => {
    expect(hbaseCellInput("profile:note", null)).toEqual({
      column: "profile:note",
      value: "",
      valueEncoding: "utf8",
    });
  });
});
