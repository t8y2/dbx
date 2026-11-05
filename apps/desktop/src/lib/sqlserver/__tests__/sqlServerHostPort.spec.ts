import { describe, expect, it } from "vitest";
import { parseSqlServerHostPort, resolveSqlServerPortSubmission } from "../sqlServerHostPort";

describe("parseSqlServerHostPort", () => {
  it("parses comma-separated port", () => {
    expect(parseSqlServerHostPort("gg.test.com,9005")).toEqual({
      host: "gg.test.com",
      port: 9005,
      portExplicit: true,
    });
  });

  it("parses comma-separated port with whitespace", () => {
    expect(parseSqlServerHostPort(" 192.168.1.100, 14333 ")).toEqual({
      host: "192.168.1.100",
      port: 14333,
      portExplicit: true,
    });
  });

  it("strips tcp: prefix and extracts comma-separated port", () => {
    expect(parseSqlServerHostPort("tcp:gg.test.com,9005")).toEqual({
      host: "gg.test.com",
      port: 9005,
      portExplicit: true,
    });
  });

  it("strips tcp: prefix without port", () => {
    expect(parseSqlServerHostPort("tcp:gg.test.com", 1433)).toEqual({
      host: "gg.test.com",
      port: 1433,
      portExplicit: false,
    });
  });

  it("parses colon-separated port", () => {
    expect(parseSqlServerHostPort("gg.test.com:9005")).toEqual({
      host: "gg.test.com",
      port: 9005,
      portExplicit: true,
    });
  });

  it("parses named instance with comma port", () => {
    expect(parseSqlServerHostPort("192.168.1.10\\SQL2022,14333")).toEqual({
      host: "192.168.1.10\\SQL2022",
      port: 14333,
      portExplicit: true,
    });
  });

  it("parses named instance with tcp prefix", () => {
    expect(parseSqlServerHostPort("tcp:192.168.1.10\\SQL2022", 1433)).toEqual({
      host: "192.168.1.10\\SQL2022",
      port: 1433,
      portExplicit: false,
    });
  });

  it("parses bracketed IPv6 with comma or colon port", () => {
    expect(parseSqlServerHostPort("[::1],9005")).toEqual({
      host: "[::1]",
      port: 9005,
      portExplicit: true,
    });
    expect(parseSqlServerHostPort("[::1]:9005")).toEqual({
      host: "[::1]",
      port: 9005,
      portExplicit: true,
    });
  });

  it("keeps regular host without port", () => {
    expect(parseSqlServerHostPort("localhost", 1433)).toEqual({
      host: "localhost",
      port: 1433,
      portExplicit: false,
    });
    expect(parseSqlServerHostPort("", 1433)).toEqual({
      host: "",
      port: 1433,
      portExplicit: false,
    });
  });

  it.each(["[::1],70000", "[::1]:oops", "[::1]:0", "[::1]unexpected", "server:1e3", "server,0x599"])("preserves invalid endpoint text instead of selecting a different port: %s", (host) => {
    expect(parseSqlServerHostPort(host, 1433)).toEqual({ host, port: 1433, portExplicit: false });
  });
});

describe("resolveSqlServerPortSubmission", () => {
  it("falls back to the default port when the field is empty (#14239)", () => {
    expect(resolveSqlServerPortSubmission("", 1433)).toEqual({ port: 1433, portExplicit: false });
    expect(resolveSqlServerPortSubmission(undefined, 1433)).toEqual({ port: 1433, portExplicit: false });
    expect(resolveSqlServerPortSubmission(Number.NaN, 1433)).toEqual({ port: 1433, portExplicit: false });
  });

  it("does not keep the port explicit when it is the default (#14238)", () => {
    expect(resolveSqlServerPortSubmission(1433, 1433)).toEqual({ port: 1433, portExplicit: false });
    expect(resolveSqlServerPortSubmission("1433", 1433)).toEqual({ port: 1433, portExplicit: false });
  });

  it("keeps a deliberately different port explicit", () => {
    expect(resolveSqlServerPortSubmission("1500", 1433)).toEqual({ port: 1500, portExplicit: true });
  });

  it("falls back to the default for values the backend u16 would reject", () => {
    expect(resolveSqlServerPortSubmission(70000, 1433)).toEqual({ port: 1433, portExplicit: false });
    expect(resolveSqlServerPortSubmission("1433.5", 1433)).toEqual({ port: 1433, portExplicit: false });
    expect(resolveSqlServerPortSubmission(-1, 1433)).toEqual({ port: 1433, portExplicit: false });
  });
});
