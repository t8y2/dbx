import { describe, expect, it } from "vitest";
import { applyDamengSslUrlParams, damengSslFormConfig } from "@/lib/database/damengSslOptions";

describe("Dameng SSL URL parameters", () => {
  it("reads SSL fields without changing parameter casing requirements", () => {
    expect(damengSslFormConfig("schema=APP&sslFilesPath=/Users/test/dmcert&sslkeystorePass=secret&sslProtocol=TLSv1.2")).toEqual({
      enabled: true,
      sslFilesPath: "/Users/test/dmcert",
      sslKeystorePassword: "secret",
      sslProtocol: "TLSv1.2",
    });
  });

  it("updates SSL fields while preserving unrelated URL parameters", () => {
    expect(applyDamengSslUrlParams("?schema=APP;compatMode=oracle", true, "/opt/dm/cert", "changeit", "TLSv1.2")).toBe("schema=APP&compatMode=oracle&sslFilesPath=/opt/dm/cert&sslkeystorePass=changeit&sslProtocol=TLSv1.2");
  });

  it("removes only managed SSL fields when SSL is disabled", () => {
    expect(applyDamengSslUrlParams("schema=APP&sslFilesPath=/opt/dm/cert&sslkeystorePass=secret&sslProtocol=TLSv1.2&foo=", false, "", "", "")).toBe("schema=APP&foo=");
  });
});
