import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");
const etcdBrowserSource = readFileSync(new URL("../../etcd/EtcdKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser node export", () => {
  it("shows export for both value keys and virtual directories", () => {
    expect(browserSource).toContain("if (props.api.exportScope || nodeHasValue(node))");
    expect(browserSource).toContain('kind: nodeIsExpandable(node) ? "prefix" : "key"');
    expect(browserSource).toContain("await props.api.exportScope(props.connectionId, request)");
  });

  it("delegates etcd directory export to a fixed-revision recursive scan", () => {
    expect(etcdBrowserSource).toContain("exportScope: exportEtcdNodeScope");
    expect(etcdBrowserSource).toContain("const scan = await scanConnection(connectionId, request.path)");
    expect(etcdBrowserSource).toContain("isKeyInKvExportScope(displayKey(keyValue(entry), entry.key), request)");
    expect(etcdBrowserSource).toContain("const missingValue = entries.find((entry) => !entry.value)");
  });

  it("keeps mirror deletes inside the exported directory and compares canonical Key bytes", () => {
    expect(etcdBrowserSource).toContain("if (!isKeyInKvExportScope(shown, mirrorScope)");
    expect(etcdBrowserSource).toContain("sourceKeys.has(kvValueByteIdentity(bytes))");
    expect(etcdBrowserSource).toContain("id: `source:${kvValueByteIdentity(source.key)}`");
    expect(etcdBrowserSource).not.toContain("id: source.key.data");
    expect(etcdBrowserSource).toContain('const mirrorDeleteAvailable = computed(() => transferBundle.value?.scopeKind === "prefix")');
    expect(etcdBrowserSource).toContain(':disabled="!mirrorDeleteAvailable || transferLoading || transferApplying"');
  });

  it("snapshots the target and invalidates stale transfer previews", () => {
    expect(etcdBrowserSource).toContain("const targetId = targetConnectionId.value");
    expect(etcdBrowserSource).toContain("const generation = ++transferPreviewGeneration");
    expect(etcdBrowserSource).toContain("if (generation !== transferPreviewGeneration) return");
    expect(etcdBrowserSource).toContain(':disabled="transferLoading || transferApplying"');
  });

  it("refreshes a partial batch before allowing the remaining operations to retry", () => {
    expect(etcdBrowserSource).toContain('row.operation = "applied"');
    expect(etcdBrowserSource).toContain("await previewTransfer()");
    expect(etcdBrowserSource).toContain('t("etcd.transferPartiallyApplied"');
  });
});
