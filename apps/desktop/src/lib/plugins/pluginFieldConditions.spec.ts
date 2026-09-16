import { describe, expect, it } from "vitest";
import { pluginFieldConditionMatches, pluginFieldIsRequired, pluginFieldIsVisible } from "./pluginFieldConditions";
import type { PluginFormField, PluginFormFieldValue } from "@/types/database";

function field(overrides: Partial<PluginFormField>): PluginFormField {
  return { key: "demo", label: "Demo", type: "text", ...overrides } as PluginFormField;
}

const readValue = (key: string) => (key === "mode" ? "custom" : undefined);

describe("pluginFieldConditionMatches", () => {
  it("matches a missing condition and a listed value", () => {
    expect(pluginFieldConditionMatches(undefined, undefined)).toBe(true);
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, "custom")).toBe(true);
  });

  it("rejects an unlisted or empty value", () => {
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, "direct")).toBe(false);
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, undefined)).toBe(false);
  });
});

describe("pluginFieldIsRequired", () => {
  it("honors static required", () => {
    expect(pluginFieldIsRequired(field({ required: true }), readValue)).toBe(true);
  });

  it("treats a field without required_when as optional", () => {
    expect(pluginFieldIsRequired(field({}), readValue)).toBe(false);
  });

  it("requires a field only while its required_when matches", () => {
    const conditional = field({ required_when: { field: "mode", one_of: ["custom"] } });
    expect(pluginFieldIsRequired(conditional, readValue)).toBe(true);
    expect(pluginFieldIsRequired(conditional, () => "direct")).toBe(false);
    expect(pluginFieldIsRequired(conditional, () => undefined)).toBe(false);
  });
});

describe("pluginFieldIsVisible", () => {
  it("renders fields without visible_when and gates conditional ones", () => {
    expect(pluginFieldIsVisible(field({}), readValue)).toBe(true);
    const conditional = field({ visible_when: { field: "mode", one_of: ["custom"] } });
    expect(pluginFieldIsVisible(conditional, readValue)).toBe(true);
    expect(pluginFieldIsVisible(conditional, () => "direct")).toBe(false);
  });

  it("keeps a condition dormant while its referenced sibling is hidden, even when the sibling default would match", () => {
    // kafka-shaped chain: sasl_mechanism (default PLAIN, hidden) →
    // oauth_token_source (visible only for OAUTHBEARER, defaults msk_iam) →
    // msk_region. The msk_iam default must not surface msk_region while SASL
    // is off, otherwise the dialog footer dead-locks on an unfillable field.
    const fields: Record<string, PluginFormField> = {
      security_protocol: field({ key: "security_protocol", default: "PLAINTEXT" }),
      sasl_mechanism: field({ key: "sasl_mechanism", default: "PLAIN", visible_when: { field: "security_protocol", one_of: ["SASL_PLAINTEXT", "SASL_SSL"] } }),
      oauth_token_source: field({ key: "oauth_token_source", default: "msk_iam", visible_when: { field: "sasl_mechanism", one_of: ["OAUTHBEARER"] } }),
      msk_region: field({ key: "msk_region", visible_when: { field: "oauth_token_source", one_of: ["msk_iam"] } }),
    };
    const read: (key: string) => PluginFormFieldValue = (key) => fields[key]?.default;
    const resolve: (key: string) => PluginFormField | undefined = (key) => fields[key];

    expect(pluginFieldIsVisible(fields.msk_region, read, resolve)).toBe(false);
    // Turning OAUTHBEARER on makes the whole chain visible again.
    const readOauth: (key: string) => PluginFormFieldValue = (key) => (key === "sasl_mechanism" ? "OAUTHBEARER" : key === "security_protocol" ? "SASL_SSL" : fields[key]?.default);
    expect(pluginFieldIsVisible(fields.oauth_token_source, readOauth, resolve)).toBe(true);
    expect(pluginFieldIsVisible(fields.msk_region, readOauth, resolve)).toBe(true);
  });

  it("ignores unknown condition fields and survives self-referencing cycles", () => {
    const unknown = field({ visible_when: { field: "missing", one_of: ["x"] } });
    expect(
      pluginFieldIsVisible(
        unknown,
        () => "x",
        () => undefined,
      ),
    ).toBe(true);
    const selfRef = field({ key: "loop", visible_when: { field: "loop", one_of: ["x"] } });
    expect(
      pluginFieldIsVisible(
        selfRef,
        () => "x",
        (key) => (key === "loop" ? selfRef : undefined),
      ),
    ).toBe(true);
  });
});
