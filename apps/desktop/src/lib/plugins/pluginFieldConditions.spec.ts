import { describe, expect, it } from "vitest";
import { pluginConditionValueText, pluginFieldConditionMatches, pluginFieldConditionReferencedFields, pluginFieldIsRequired, pluginFieldIsVisible } from "./pluginFieldConditions";
import type { PluginFieldCondition, PluginFormField, PluginFormFieldValue } from "@/types/database";

function field(overrides: Partial<PluginFormField>): PluginFormField {
  return { key: "demo", label: "Demo", type: "text", ...overrides } as PluginFormField;
}

const readValue = (key: string): PluginFormFieldValue => (key === "mode" ? "custom" : undefined);
/** Reads a fixed map, so a condition can be evaluated against known values. */
function reader(values: Record<string, PluginFormFieldValue>): (key: string) => PluginFormFieldValue {
  return (key) => values[key];
}

describe("pluginFieldConditionMatches", () => {
  it("matches a missing condition and a listed value", () => {
    expect(pluginFieldConditionMatches(undefined, () => undefined)).toBe(true);
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, reader({ mode: "custom" }))).toBe(true);
  });

  it("rejects an unlisted or empty value", () => {
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, reader({ mode: "direct" }))).toBe(false);
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, reader({}))).toBe(false);
    expect(pluginFieldConditionMatches({ field: "mode", one_of: ["custom"] }, reader({ mode: "  " }))).toBe(false);
  });

  it("compares boolean and number literals by canonical string form", () => {
    // `read_only = false` is the composite-condition driver the SSH plugin needs.
    const readOnly = { field: "read_only", one_of: [false] } as PluginFieldCondition;
    expect(pluginFieldConditionMatches(readOnly, reader({ read_only: false }))).toBe(true);
    expect(pluginFieldConditionMatches(readOnly, reader({ read_only: true }))).toBe(false);
    expect(pluginFieldConditionMatches({ field: "read_only", one_of: ["false"] }, reader({ read_only: false }))).toBe(true);
    expect(pluginFieldConditionMatches({ field: "port", one_of: [2222] }, reader({ port: 2222 }))).toBe(true);
    expect(pluginFieldConditionMatches({ field: "port", one_of: [2222.0] }, reader({ port: 2222 }))).toBe(true);
    expect(pluginConditionValueText(false)).toBe("false");
    expect(pluginConditionValueText(22)).toBe("22");
  });

  it("composes clauses with all_of, any_of and not", () => {
    const allOf = {
      all_of: [
        { field: "sudo_source", one_of: ["custom"] },
        { field: "read_only", one_of: [false] },
      ],
    } as PluginFieldCondition;
    expect(pluginFieldConditionMatches(allOf, reader({ sudo_source: "custom", read_only: false }))).toBe(true);
    expect(pluginFieldConditionMatches(allOf, reader({ sudo_source: "custom", read_only: true }))).toBe(false);
    expect(pluginFieldConditionMatches(allOf, reader({ sudo_source: "default", read_only: false }))).toBe(false);

    const anyOf = {
      any_of: [
        { field: "authentication", one_of: ["password"] },
        { field: "authentication", one_of: ["keyboard-interactive"] },
      ],
    } as PluginFieldCondition;
    expect(pluginFieldConditionMatches(anyOf, reader({ authentication: "keyboard-interactive" }))).toBe(true);
    expect(pluginFieldConditionMatches(anyOf, reader({ authentication: "agent" }))).toBe(false);

    const not = { not: { field: "read_only", one_of: [true] } } as PluginFieldCondition;
    expect(pluginFieldConditionMatches(not, reader({ read_only: false }))).toBe(true);
    expect(pluginFieldConditionMatches(not, reader({ read_only: true }))).toBe(false);

    const nested = { all_of: [anyOf, not, { any_of: [{ all_of: [{ field: "read_only", one_of: [false] }] }] }] } as PluginFieldCondition;
    expect(pluginFieldConditionMatches(nested, reader({ authentication: "password", read_only: false }))).toBe(true);
    expect(pluginFieldConditionMatches(nested, reader({ authentication: "password", read_only: true }))).toBe(false);
  });

  it("lists every referenced field of a nested expression", () => {
    expect(
      pluginFieldConditionReferencedFields({
        all_of: [
          {
            any_of: [
              { field: "a", one_of: ["1"] },
              { field: "b", one_of: ["1"] },
            ],
          },
          { not: { field: "c", one_of: ["1"] } },
        ],
      }),
    ).toEqual(["a", "b", "c"]);
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

  it("requires a field only while every clause of an all_of required_when matches", () => {
    const conditional = field({
      required_when: {
        all_of: [
          { field: "sudo_source", one_of: ["custom"] },
          { field: "read_only", one_of: [false] },
        ],
      },
    });
    expect(pluginFieldIsRequired(conditional, reader({ sudo_source: "custom", read_only: false }))).toBe(true);
    expect(pluginFieldIsRequired(conditional, reader({ sudo_source: "custom", read_only: true }))).toBe(false);
  });
});

describe("pluginFieldIsVisible", () => {
  it("renders fields without visible_when and gates conditional ones", () => {
    expect(pluginFieldIsVisible(field({}), readValue)).toBe(true);
    const conditional = field({ visible_when: { field: "mode", one_of: ["custom"] } });
    expect(pluginFieldIsVisible(conditional, readValue)).toBe(true);
    expect(pluginFieldIsVisible(conditional, () => "direct")).toBe(false);
  });

  it("renders a field only while every clause of an all_of visible_when matches", () => {
    const conditional = field({
      visible_when: {
        all_of: [
          { field: "sudo_source", one_of: ["custom"] },
          { field: "read_only", one_of: [false] },
        ],
      },
    });
    expect(pluginFieldIsVisible(conditional, reader({ sudo_source: "custom", read_only: false }))).toBe(true);
    expect(pluginFieldIsVisible(conditional, reader({ sudo_source: "custom", read_only: true }))).toBe(false);
    expect(pluginFieldIsVisible(conditional, reader({ read_only: false }))).toBe(false);
  });

  it("keeps an unused any_of branch from hiding a matching field", () => {
    // `visible_when.any_of` matches through the first clause; the second clause
    // references a sibling that is itself hidden, and that must not matter.
    const fields: Record<string, PluginFormField> = {
      source: field({ key: "source", default: "custom" }),
      hidden_controller: field({ key: "hidden_controller", default: "on", visible_when: { field: "source", one_of: ["remote"] } }),
      target: field({
        key: "target",
        visible_when: {
          any_of: [
            { field: "source", one_of: ["custom"] },
            { field: "hidden_controller", one_of: ["on"] },
          ],
        },
      }),
    };
    const read: (key: string) => PluginFormFieldValue = (key) => fields[key]?.default ?? undefined;
    const resolve: (key: string) => PluginFormField | undefined = (key) => fields[key];

    expect(pluginFieldIsVisible(fields.target, read, resolve)).toBe(true);
    // ...while a match that *depends* on the hidden controller stays dormant.
    const onlyHidden = field({
      key: "only_hidden",
      visible_when: { any_of: [{ field: "hidden_controller", one_of: ["on"] }] },
    });
    expect(pluginFieldIsVisible(onlyHidden, read, resolve)).toBe(false);
  });

  it("treats a hidden operand of `not` as dormant instead of lighting the field up", () => {
    const fields: Record<string, PluginFormField> = {
      mode: field({ key: "mode", default: "remote" }),
      read_only: field({ key: "read_only", default: false, visible_when: { field: "mode", one_of: ["local"] } }),
      writable_options: field({ key: "writable_options", visible_when: { not: { field: "read_only", one_of: [true] } } }),
    };
    const read: (key: string) => PluginFormFieldValue = (key) => fields[key]?.default ?? undefined;
    const resolve: (key: string) => PluginFormField | undefined = (key) => fields[key];

    expect(pluginFieldIsVisible(fields.writable_options, read, resolve)).toBe(false);
    const localRead = reader({ mode: "local", read_only: false });
    expect(pluginFieldIsVisible(fields.writable_options, localRead, resolve)).toBe(true);
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
    const read: (key: string) => PluginFormFieldValue = (key) => fields[key]?.default ?? undefined;
    const resolve: (key: string) => PluginFormField | undefined = (key) => fields[key];

    expect(pluginFieldIsVisible(fields.msk_region, read, resolve)).toBe(false);
    // Turning OAUTHBEARER on makes the whole chain visible again.
    const readOauth: (key: string) => PluginFormFieldValue = (key) => (key === "sasl_mechanism" ? "OAUTHBEARER" : key === "security_protocol" ? "SASL_SSL" : (fields[key]?.default ?? undefined));
    expect(pluginFieldIsVisible(fields.oauth_token_source, readOauth, resolve)).toBe(true);
    expect(pluginFieldIsVisible(fields.msk_region, readOauth, resolve)).toBe(true);
  });

  it.each([false, true])("keeps sibling branches path-local with reverse order %s", (reverse) => {
    const fields: Record<string, PluginFormField> = {
      mode: field({ key: "mode" }),
      auth: field({ key: "auth", visible_when: { field: "mode", one_of: ["enabled"] } }),
    };
    const clause: PluginFieldCondition = { field: "auth", one_of: ["password"] };
    const branches: PluginFieldCondition[] = [{ all_of: [clause, { field: "flag", one_of: [true] }] }, { all_of: [{ field: "flag", one_of: [false] }, clause] }];
    if (reverse) branches.reverse();
    const resolve = (key: string) => fields[key];
    for (const flag of [false, true]) {
      const hidden = reader({ mode: "disabled", auth: "password", flag });
      const visible = reader({ mode: "enabled", auth: "password", flag });
      for (const condition of [clause, { any_of: [clause, clause] }, { any_of: branches }, { all_of: [clause, clause] }] satisfies PluginFieldCondition[]) {
        const target = field({ key: "target", visible_when: condition });
        expect(pluginFieldIsVisible(target, hidden, resolve)).toBe(false);
        expect(pluginFieldIsVisible(target, visible, resolve)).toBe(true);
      }
      const negated = field({ visible_when: { not: { any_of: [clause, clause] } } });
      expect(pluginFieldIsVisible(negated, hidden, resolve)).toBe(false);
      expect(pluginFieldIsVisible(negated, reader({ mode: "enabled", auth: "token", flag }), resolve)).toBe(true);
    }
  });

  it("preserves true mutual-cycle compatibility without bypassing value checks", () => {
    const fields: Record<string, PluginFormField> = {
      first: field({ key: "first", visible_when: { field: "second", one_of: ["on"] } }),
      second: field({ key: "second", visible_when: { field: "first", one_of: ["on"] } }),
    };
    const resolve = (key: string) => fields[key];
    expect(pluginFieldIsVisible(fields.first, reader({ first: "on", second: "on" }), resolve)).toBe(true);
    expect(pluginFieldIsVisible(fields.first, reader({ first: "off", second: "on" }), resolve)).toBe(false);
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
