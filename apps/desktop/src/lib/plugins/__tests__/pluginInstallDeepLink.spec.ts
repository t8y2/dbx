import { describe, expect, it } from "vitest";
import { parsePluginInstallDeepLink } from "../pluginInstallDeepLink";

const PACKAGE_URL = "https://dl.dbxio.com/plugins/io.dbx.ssh/0.4.73/io.dbx.ssh-0.4.73-darwin-arm64.dbxp";

describe("parsePluginInstallDeepLink", () => {
  it("extracts the encoded package url", () => {
    const draft = parsePluginInstallDeepLink(`dbx://plugins/install?url=${encodeURIComponent(PACKAGE_URL)}`);
    expect(draft).toEqual({ url: PACKAGE_URL });
  });

  it("returns null for non-plugin links and junk", () => {
    expect(parsePluginInstallDeepLink("dbx://connection/new?type=mysql")).toBeNull();
    expect(parsePluginInstallDeepLink("dbx://plugins/installed?url=https://example.com/a.dbxp")).toBeNull();
    expect(parsePluginInstallDeepLink("dbx://plugins/installation?url=https://example.com/a.dbxp")).toBeNull();
    expect(parsePluginInstallDeepLink("")).toBeNull();
    expect(parsePluginInstallDeepLink("not a url")).toBeNull();
  });

  it("throws for matching links without a usable url param", () => {
    expect(() => parsePluginInstallDeepLink("dbx://plugins/install")).toThrow(/Missing url/);
    expect(() => parsePluginInstallDeepLink("dbx://plugins/install?url=")).toThrow(/Missing url/);
    expect(() => parsePluginInstallDeepLink(`dbx://plugins/install?url=${encodeURIComponent("ftp://example.com/a.dbxp")}`)).toThrow(/http/);
    expect(() => parsePluginInstallDeepLink(`dbx://plugins/install?url=${encodeURIComponent(`https://example.com/${"a".repeat(2100)}`)}`)).toThrow(/too long/);
  });
});
