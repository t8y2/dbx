import { describe, expect, it } from "vitest";
import {
  buildNacosContentSearchCsv,
  buildNacosConfigExportFileName,
  buildNacosConfigDeleteConfirm,
  buildNacosInlineDiff,
  buildNacosInstanceConfirm,
  buildNacosRawRequest,
  buildNacosSideBySideDiff,
  canDeleteNacosConfig,
  canStartNacosConfigDelete,
  canStartNacosConfigSave,
  createNacosConfigDeleteSnapshot,
  createNacosConfigSaveSnapshot,
  createNacosLatestRequestGuard,
  isNacosRawMutation,
  isNacosErrorCode,
  isNacosConfigSaveSnapshotCurrent,
  isNacosConfigDeleteSnapshotInScope,
  nacosConfigFileExtension,
  nacosMetricsCandidates,
  normalizeNacosMetricsUrl,
  parseNacosRawBody,
  parseNacosRawQuery,
  normalizeNacosEndpoint,
  resolveRNacosOpenApiFallback,
  resolveNacosConfigCopyText,
  resolveNacosConfigSaveCompletion,
  sanitizeNacosConfigFileNameSegment,
  splitNacosContentLiteralMatches,
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
    expect(normalizeNacosEndpoint("http://127.0.0.1:8848", { implementation: "nacos", versionMode: "v3" })).toMatchObject({
      serverAddr: "http://127.0.0.1:8848",
      contextPath: "/nacos",
      detectedVersion: "v3",
    });
    expect(normalizeNacosEndpoint("http://127.0.0.1:8848", { implementation: "nacos", versionMode: "v3", contextPath: "/" })).toMatchObject({
      serverAddr: "http://127.0.0.1:8848",
      contextPath: "/",
      detectedVersion: "v3",
    });
    const savedAutoRootEndpoint = normalizeNacosEndpoint("http://127.0.0.1:8080", { implementation: "nacos", versionMode: "auto" });
    expect(savedAutoRootEndpoint).toMatchObject({ serverAddr: "http://127.0.0.1:8080", contextPath: "" });
    expect(
      normalizeNacosEndpoint(savedAutoRootEndpoint.serverAddr, {
        implementation: "nacos",
        versionMode: "auto",
        contextPath: savedAutoRootEndpoint.contextPath || undefined,
      }),
    ).toMatchObject({ serverAddr: "http://127.0.0.1:8080", contextPath: "" });
    expect(normalizeNacosEndpoint("http://rnacos.example:8848/nacos", { implementation: "rnacos" })).toMatchObject({
      serverAddr: "http://rnacos.example:8848",
      contextPath: "/nacos",
    });
    expect(() => normalizeNacosEndpoint("http://user:secret@nacos.example", { implementation: "nacos" })).toThrow(/embedded credentials/i);
  });

  it("derives and validates Prometheus endpoints", () => {
    expect(nacosMetricsCandidates("http://127.0.0.1:8818", "/nacos", "nacos")).toEqual(["http://127.0.0.1:8818/nacos/actuator/prometheus", "http://127.0.0.1:8818/actuator/prometheus"]);
    expect(nacosMetricsCandidates("http://127.0.0.1:3848", "/nacos", "rnacos")).toEqual(["http://127.0.0.1:3848/metrics", "http://127.0.0.1:3848/nacos/metrics", "http://127.0.0.1:3848/rnacos/metrics"]);
    expect(normalizeNacosMetricsUrl("http://localhost:8818/metrics?node=a")).toBe("http://localhost:8818/metrics?node=a");
    expect(() => normalizeNacosMetricsUrl("file:///tmp/metrics")).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeNacosMetricsUrl("http://user:secret@localhost/metrics")).toThrow(/credentials/);
    expect(() => normalizeNacosMetricsUrl("http://localhost/metrics#fragment")).toThrow(/fragment/);
    expect(() => normalizeNacosMetricsUrl("http://localhost/metrics#")).toThrow(/fragment/);
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

  it("recognizes structured Nacos errors without matching unrelated failures", () => {
    expect(isNacosErrorCode(new Error("NACOS_ERROR[stalePreview]: preview again"), "stalePreview")).toBe(true);
    expect(isNacosErrorCode("NACOS_ERROR[authFailed]: forbidden", "stalePreview")).toBe(false);
    expect(isNacosErrorCode(new Error("stalePreview"), "stalePreview")).toBe(false);
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

  it("uses the same terminal newline semantics for diff summaries", () => {
    expect(summarizeNacosConfigDiff("aa", "aa\nbb")).toMatchObject({ changed: true, addedLines: 1, removedLines: 0 });
    expect(summarizeNacosConfigDiff("aa", "aa\n")).toEqual({ changed: false, addedLines: 0, removedLines: 0, preview: "No content changes." });
    expect(summarizeNacosConfigDiff("aa\r\n", "aa\n")).toEqual({ changed: false, addedLines: 0, removedLines: 0, preview: "No content changes." });
  });

  it("builds side-by-side config diff rows with inline segments", () => {
    const rows = buildNacosSideBySideDiff('cloud:\n  secret: "aaa"\n', 'cloud:\n  secret: "aaa1"\n  enabled: true\n');
    expect(rows[0]).toMatchObject({ leftLineNumber: 1, rightLineNumber: 1, leftType: "equal", rightType: "equal" });
    expect(rows[1]).toMatchObject({ leftLineNumber: 2, rightLineNumber: 2, leftType: "modify", rightType: "modify" });
    expect(rows[1].rightInline.some((segment) => segment.changed && segment.value === "1")).toBe(true);
    expect(rows[2]).toMatchObject({ leftLineNumber: null, rightLineNumber: 3, leftType: "padding", rightType: "insert" });
  });

  it("keeps unchanged lines when appending without a trailing newline", () => {
    const rows = buildNacosSideBySideDiff("aa", "aa\nbb");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ leftLineNumber: 1, rightLineNumber: 1, leftContent: "aa", rightContent: "aa", leftType: "equal", rightType: "equal" });
    expect(rows[1]).toMatchObject({ leftLineNumber: null, rightLineNumber: 2, leftContent: "", rightContent: "bb", leftType: "padding", rightType: "insert" });

    const inlineRows = buildNacosInlineDiff("aa", "aa\nbb");
    expect(inlineRows).toMatchObject([
      { lineNumber: 1, content: "aa", type: "equal" },
      { lineNumber: 2, content: "bb", type: "insert" },
    ]);
    expect(inlineRows.some((row) => row.type === "delete")).toBe(false);
  });

  it("normalizes line endings and ignores terminal newline-only differences", () => {
    expect(buildNacosSideBySideDiff("aa\n", "aa\nbb\n")).toMatchObject([
      { leftContent: "aa", rightContent: "aa", leftType: "equal", rightType: "equal" },
      { leftLineNumber: null, rightContent: "bb", leftType: "padding", rightType: "insert" },
    ]);
    expect(buildNacosSideBySideDiff("aa\r\n", "aa\n")).toMatchObject([{ leftContent: "aa", rightContent: "aa", leftType: "equal", rightType: "equal" }]);
    expect(buildNacosSideBySideDiff("aa\n", "aa")).toMatchObject([{ leftContent: "aa", rightContent: "aa", leftType: "equal", rightType: "equal" }]);
  });

  it("handles empty config content as line insertions", () => {
    expect(buildNacosSideBySideDiff("", "bb")).toMatchObject([{ leftLineNumber: null, rightLineNumber: 1, rightContent: "bb", leftType: "padding", rightType: "insert" }]);
    expect(buildNacosSideBySideDiff("", "")).toEqual([]);
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

  it("rejects stale config detail requests after a newer selection or invalidation", () => {
    const guard = createNacosLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });

  it("keeps a late A detail response from replacing a newer B selection", async () => {
    const guard = createNacosLatestRequestGuard();
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const responseB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });
    let selected = "";
    const load = async (response: Promise<string>) => {
      const requestId = guard.begin();
      const detail = await response;
      if (guard.isCurrent(requestId)) selected = detail;
    };

    const loadingA = load(responseA);
    const loadingB = load(responseB);
    resolveB("B");
    await loadingB;
    resolveA("A");
    await loadingA;

    expect(selected).toBe("B");
  });

  it("keeps save payloads immutable and applies them only to the unchanged editor session", () => {
    const editedConfig = {
      namespace: "dev",
      dataId: "application.yaml",
      group: "DEFAULT_GROUP",
      configType: "yaml",
      appName: "gateway",
      desc: "published settings",
      tags: "prod",
    };
    const snapshot = createNacosConfigSaveSnapshot({
      requestId: 4,
      editorSessionId: 9,
      connectionId: "nacos-a",
      originalKey: { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" },
      config: editedConfig,
      content: "server:\n  port: 8080",
      configType: "yaml",
    });
    editedConfig.desc = "changed after publish started";

    expect(snapshot.config.desc).toBe("published settings");
    expect(snapshot.content).toBe("server:\n  port: 8080");
    expect(
      isNacosConfigSaveSnapshotCurrent(snapshot, {
        latestRequestId: 4,
        editorSessionId: 9,
        connectionId: "nacos-a",
        originalKey: { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" },
        config: { ...snapshot.config },
        content: snapshot.content,
        configType: snapshot.configType,
      }),
    ).toBe(true);
  });

  it("does not apply a completed save to another selection or to later edits", () => {
    const snapshot = createNacosConfigSaveSnapshot({
      requestId: 1,
      editorSessionId: 3,
      connectionId: "nacos-a",
      originalKey: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP" },
      config: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP", desc: "A" },
      content: "value: A",
      configType: "yaml",
    });
    const matchingState = {
      latestRequestId: 1,
      editorSessionId: 3,
      connectionId: "nacos-a",
      originalKey: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP" },
      config: { ...snapshot.config },
      content: snapshot.content,
      configType: snapshot.configType,
    };

    expect(isNacosConfigSaveSnapshotCurrent(snapshot, { ...matchingState, editorSessionId: 4, config: { ...snapshot.config, dataId: "b.yaml" } })).toBe(false);
    expect(isNacosConfigSaveSnapshotCurrent(snapshot, { ...matchingState, content: "value: edited while saving" })).toBe(false);
    expect(isNacosConfigSaveSnapshotCurrent(snapshot, { ...matchingState, latestRequestId: 2 })).toBe(false);
  });

  it("advances the published baseline without overwriting edits made while saving", () => {
    const originalContent = "value: O";
    const publishedContent = "value: S";
    const laterContent = "value: T";
    const snapshot = createNacosConfigSaveSnapshot({
      requestId: 7,
      editorSessionId: 12,
      connectionId: "nacos-a",
      originalKey: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP" },
      config: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP", desc: "snapshot metadata" },
      content: publishedContent,
      configType: "yaml",
    });
    const completion = resolveNacosConfigSaveCompletion(snapshot, {
      latestRequestId: 7,
      editorSessionId: 12,
      connectionId: "nacos-a",
      originalKey: { namespace: "dev", dataId: "a.yaml", group: "DEFAULT_GROUP" },
      config: { ...snapshot.config, desc: "edited metadata" },
      content: laterContent,
      configType: "yaml",
    });

    expect(completion.kind).toBe("saved-with-later-edits");
    if (completion.kind === "stale") throw new Error("expected a relevant save completion");
    expect(completion.baseline.content).toBe(publishedContent);
    expect(laterContent).not.toBe(completion.baseline.content);
    expect(originalContent).not.toBe(completion.baseline.content);
  });

  it("keeps a renamed draft separate from the identity published by an in-flight save", () => {
    const snapshot = createNacosConfigSaveSnapshot({
      requestId: 8,
      editorSessionId: 13,
      connectionId: "nacos-a",
      originalKey: null,
      config: { namespace: "dev", dataId: "draft-a.yaml", group: "DEFAULT_GROUP" },
      content: "value: S",
      configType: "yaml",
    });
    const completion = resolveNacosConfigSaveCompletion(snapshot, {
      latestRequestId: 8,
      editorSessionId: 13,
      connectionId: "nacos-a",
      originalKey: null,
      config: { ...snapshot.config, dataId: "draft-b.yaml" },
      content: "value: T",
      configType: "yaml",
    });

    expect(completion).toEqual({ kind: "stale" });
  });

  it("never allows a draft or read-only config to enter the delete flow", () => {
    const publishedKey = { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" };
    expect(canDeleteNacosConfig(false, publishedKey)).toBe(true);
    expect(canDeleteNacosConfig(false, null)).toBe(false);
    expect(canDeleteNacosConfig(true, publishedKey)).toBe(false);
  });

  it("keeps save and delete mutations mutually exclusive in both directions", () => {
    const idle = {
      readOnly: false,
      saving: false,
      deleting: false,
      hasPendingDelete: false,
      hasPendingSave: false,
    };
    const publishedKey = { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" };

    expect(canStartNacosConfigSave(idle)).toBe(true);
    expect(canStartNacosConfigSave({ ...idle, saving: true })).toBe(false);
    expect(canStartNacosConfigSave({ ...idle, deleting: true })).toBe(false);
    expect(canStartNacosConfigSave({ ...idle, hasPendingDelete: true })).toBe(false);
    expect(canStartNacosConfigDelete(idle, publishedKey)).toBe(true);
    expect(canStartNacosConfigDelete({ ...idle, saving: true }, publishedKey)).toBe(false);
    expect(canStartNacosConfigDelete({ ...idle, deleting: true }, publishedKey)).toBe(false);
    expect(canStartNacosConfigDelete({ ...idle, hasPendingSave: true }, publishedKey)).toBe(false);
    expect(canStartNacosConfigDelete({ ...idle, hasPendingDelete: true }, publishedKey)).toBe(false);
  });

  it("freezes delete confirmation scope and never redirects it to a newly selected connection", async () => {
    const key = { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" };
    const config = { ...key, desc: "old connection config" };
    const snapshot = createNacosConfigDeleteSnapshot("old-connection", key, config);
    key.dataId = "mutated.yaml";
    config.desc = "mutated after confirmation";
    const deletedConnections: string[] = [];
    const executeIfCurrent = async (connectionId: string, namespace: string) => {
      if (!isNacosConfigDeleteSnapshotInScope(snapshot, connectionId, namespace)) return;
      deletedConnections.push(snapshot.connectionId);
    };

    await executeIfCurrent("new-connection", "dev");
    expect(deletedConnections).toEqual([]);
    expect(snapshot).toMatchObject({
      connectionId: "old-connection",
      key: { namespace: "dev", dataId: "application.yaml", group: "DEFAULT_GROUP" },
      config: { desc: "old connection config" },
    });
  });

  it("splits every case-sensitive literal content match for safe highlighting", () => {
    expect(splitNacosContentLiteralMatches("url=/deploy/deploy?mode=Deploy", "deploy")).toEqual([
      { text: "url=/", matched: false },
      { text: "deploy", matched: true },
      { text: "/", matched: false },
      { text: "deploy", matched: true },
      { text: "?mode=Deploy", matched: false },
    ]);
    expect(splitNacosContentLiteralMatches("<script>alert(1)</script>", "alert")).toEqual([
      { text: "<script>", matched: false },
      { text: "alert", matched: true },
      { text: "(1)</script>", matched: false },
    ]);
  });

  it("exports content search matches as UTF-8 CSV and neutralizes spreadsheet formulas", () => {
    const csv = buildNacosContentSearchCsv([
      {
        namespace: "",
        group: "dev",
        dataId: '=IMPORTXML("https://example.test")',
        lineNumber: 12,
        snippet: 'url: "jdbc:mysql://db/a,b"\nuser: root',
      },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"public","dev","\'=IMPORTXML(""https://example.test"")","12"');
    expect(csv).toContain('"url: ""jdbc:mysql://db/a,b""\nuser: root"');
  });
});
