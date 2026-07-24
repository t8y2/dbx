import { describe, expect, it } from "vitest";
import {
  buildNacosConfigExportFileName,
  buildNacosConfigDeleteConfirm,
  buildNacosInlineDiff,
  buildNacosInstanceConfirm,
  buildNacosRawRequest,
  buildNacosSideBySideDiff,
  isNacosRawMutation,
  nacosConfigFileExtension,
  parseNacosRawBody,
  parseNacosRawQuery,
  normalizeNacosEndpoint,
  resolveRNacosOpenApiFallback,
  resolveNacosConfigCopyText,
  sanitizeNacosConfigFileNameSegment,
  summarizeNacosConfigDiff,
} from "@/lib/nacos/nacosAdmin";

describe("nacosAdmin helpers", () => {
  it("normalizes Nacos profile URLs without losing proxy prefixes", () => {
    expect(normalizeNacosEndpoint("https://[2001:db8::1]:9443/gateway/nacos/", { implementation: "nacos", versionMode: "v2" })).toMatchObject({
      serverAddr: "https://[2001:db8::1]:9443",
      contextPath: "/gateway/nacos",
      detectedVersion: "v2",
    });
    expect(normalizeNacosEndpoint("https://nacos.example/gateway/next/index.html", { implementation: "nacos", versionMode: "v3" })).toMatchObject({
      serverAddr: "https://nacos.example",
      contextPath: "/gateway",
      detectedVersion: "v3",
    });
    expect(normalizeNacosEndpoint("http://rnacos.example:8848/nacos", { implementation: "rnacos" })).toMatchObject({
      serverAddr: "http://rnacos.example:8848",
      contextPath: "/nacos",
    });
    expect(() => normalizeNacosEndpoint("http://user:secret@nacos.example", { implementation: "nacos" })).toThrow(/embedded credentials/i);
  });
  it("parses raw query and body text", () => {
    expect(parseNacosRawQuery("?dataId=a&group=DEFAULT_GROUP")).toEqual({ dataId: "a", group: "DEFAULT_GROUP" });
    expect(parseNacosRawQuery("")).toBeUndefined();
    expect(parseNacosRawBody('{"enabled":false}')).toEqual({ enabled: false });
    expect(parseNacosRawBody("plain text")).toBe("plain text");
  });

  it("builds raw requests and detects mutations", () => {
    const req = buildNacosRawRequest("post", " /v1/cs/configs ", "a=1", '{"b":2}');
    expect(req).toEqual({ method: "post", path: "/v1/cs/configs", query: { a: "1" }, body: { b: 2 } });
    expect(isNacosRawMutation("GET")).toBe(false);
    expect(isNacosRawMutation("DELETE")).toBe(true);
  });

  it("redirects r-nacos console settings to the compatible OpenAPI endpoint", () => {
    expect(resolveRNacosOpenApiFallback("http://rnacos.example:10848", "/rnacos")).toEqual({
      serverAddr: "http://rnacos.example:8848",
      contextPath: "/nacos",
    });
    expect(resolveRNacosOpenApiFallback("https://rnacos.example/gateway", "rnacos/")).toEqual({
      serverAddr: "https://rnacos.example/gateway",
      contextPath: "/nacos",
    });
    expect(resolveRNacosOpenApiFallback("http://nacos.example:10848", "/nacos")).toBeNull();
    expect(resolveRNacosOpenApiFallback("http://rnacos.example:10848", "", { allowConsolePortInference: true })).toEqual({
      serverAddr: "http://rnacos.example:8848",
      contextPath: "/nacos",
    });
    expect(resolveRNacosOpenApiFallback("http://rnacos.example:8848", "/nacos")).toBeNull();
  });

  it("summarizes config diffs", () => {
    const diff = summarizeNacosConfigDiff("a\nb", "a\nc\nd");
    expect(diff.changed).toBe(true);
    expect(diff.removedLines).toBe(1);
    expect(diff.addedLines).toBe(2);
    expect(diff.preview).toContain("- b");
    expect(diff.preview).toContain("+ c");
  });

  it("builds side-by-side config diff rows with inline segments", () => {
    const rows = buildNacosSideBySideDiff('cloud:\n  secret: "aaa"\n', 'cloud:\n  secret: "aaa1"\n  enabled: true\n');
    expect(rows[0]).toMatchObject({ leftLineNumber: 1, rightLineNumber: 1, leftType: "equal", rightType: "equal" });
    expect(rows[1]).toMatchObject({ leftLineNumber: 2, rightLineNumber: 2, leftType: "modify", rightType: "modify" });
    expect(rows[1].rightInline.some((segment) => segment.changed && segment.value === "1")).toBe(true);
    expect(rows[2]).toMatchObject({ leftLineNumber: null, rightLineNumber: 3, leftType: "padding", rightType: "insert" });
  });

  it("builds inline config diff rows with character-level changed segments", () => {
    const rows = buildNacosInlineDiff('secretId: "aaa1"\n', 'secretId: "aaa2"\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ lineNumber: 1, type: "delete" });
    expect(rows[1]).toMatchObject({ lineNumber: 1, type: "insert" });
    expect(rows[0].segments.some((segment) => segment.changed && segment.value === "1")).toBe(true);
    expect(rows[1].segments.some((segment) => segment.changed && segment.value === "2")).toBe(true);
  });

  it("includes identifying fields in confirmations", () => {
    expect(buildNacosConfigDeleteConfirm({ namespace: "", dataId: "app.yaml", group: "DEFAULT_GROUP" })).toContain("dataId=app.yaml");
    const details = buildNacosInstanceConfirm({ serviceName: "DEFAULT_GROUP@@svc", groupName: "DEFAULT_GROUP" }, { ip: "127.0.0.1", port: 8080, enabled: true, metadata: null }, { enabled: false }, "", "public");
    expect(details).toContain("serviceName=DEFAULT_GROUP@@svc");
    expect(details).toContain("targetEnabled=false");
  });

  it("builds safe export file names from config data id and format", () => {
    expect(sanitizeNacosConfigFileNameSegment("../prod:app?config")).toBe("prod_app_config");
    expect(nacosConfigFileExtension("yaml")).toBe("yaml");
    expect(nacosConfigFileExtension("props")).toBe("properties");
    expect(buildNacosConfigExportFileName({ dataId: "application.yaml", configType: "text" })).toBe("application.yaml");
    expect(buildNacosConfigExportFileName({ dataId: "service/config", configType: "json" })).toBe("service_config.json");
    expect(buildNacosConfigExportFileName({ dataId: "", configType: "toml" })).toBe("nacos-config.toml");
  });

  it("copies selected config text before editor text and state text", () => {
    expect(resolveNacosConfigCopyText("selected", "editor", "state")).toBe("selected");
    expect(resolveNacosConfigCopyText("", "editor", "state")).toBe("editor");
    expect(resolveNacosConfigCopyText("", "", "state")).toBe("state");
  });
});
