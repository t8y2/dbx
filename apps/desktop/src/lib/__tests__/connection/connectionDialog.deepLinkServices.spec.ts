import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog service deep-link hydration", () => {
  it("hydrates specialized refs after generic fields and before one-time submit", () => {
    const applyStart = source.indexOf("function applyConnectionDraftToForm");
    const applyEnd = source.indexOf("function applyConnectionPrefill", applyStart);
    const applyBody = source.slice(applyStart, applyEnd);
    expect(applyBody.indexOf("applyConnectionDraftToConfig")).toBeGreaterThanOrEqual(0);
    expect(applyBody.indexOf("hydrateConsulFields")).toBeGreaterThan(applyBody.indexOf("applyConnectionDraftToConfig"));
    expect(applyBody.indexOf("hydrateNacosFields")).toBeGreaterThan(applyBody.indexOf("applyConnectionDraftToConfig"));

    const prefillStart = source.indexOf("function applyConnectionPrefill");
    const prefillEnd = source.indexOf("watch(\n  open", prefillStart);
    const prefillBody = source.slice(prefillStart, prefillEnd);
    expect(prefillBody.indexOf("applyConnectionDraftToForm")).toBeLessThan(prefillBody.indexOf("submitOneTimePrefill"));
  });

  it("includes service configuration in one-time submission deduplication", () => {
    const keyStart = source.indexOf("function oneTimePrefillKey");
    const keyEnd = source.indexOf("function submitOneTimePrefill", keyStart);
    expect(source.slice(keyStart, keyEnd)).toContain("draft.serviceConfig");
  });

  it("hydrates raw service URLs through the deep-link draft path", () => {
    const applyStart = source.indexOf("function applyConnectionUrlToForm");
    const applyEnd = source.indexOf("function hasPendingConnectionUrlInput", applyStart);
    const applyBody = source.slice(applyStart, applyEnd);
    expect(applyBody).toContain("parseConnectionDeepLink(input) ?? parseServiceConnectionUrl(input)");
    expect(applyBody.indexOf("applyConnectionDraftToForm")).toBeLessThan(applyBody.indexOf("parseConnectionUrl(input"));
  });
});
