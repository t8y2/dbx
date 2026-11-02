import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import zhCN from "../locales/zh-CN";

// The Salesforce save dialog and the toolbar identity badge explain *why* a
// write may fail. The first wording claimed a non-administrator's records "are
// rejected by Salesforce row by row", which conflates two independent layers:
// field writability comes from the profile's field-level security (the grid
// already renders those columns read-only from describe's `updateable` /
// `createable`, which Salesforce computes for the current user), while
// record-level failures come from sharing rules, validation rules, Flow or
// Apex. The `Modify All Data` flag only says whether the profile bypasses
// those layers — it never decides whether a field is editable.
//
// These assertions pin the corrected contract so the misleading claim cannot
// silently return: every identity line names the profile as well as the user,
// the non-administrator line talks about permissions instead of rank, and the
// old key is gone rather than left behind unused.
const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["es", es],
  ["zh-CN", zhCN],
];

const saveIdentityKeys = ["salesforceSaveAdminIdentity", "salesforceSaveNonAdminIdentity", "salesforceSaveUnknownRights"] as const;

/** Words that would put the admin flag back at the centre of a field-level warning. */
const adminWords = ["administrator", "administrador", "administrateur", "系统管理员", "管理员"] as const;

function entry(locale: Record<string, unknown>, namespace: string, key: string): string | undefined {
  const section = locale[namespace];
  if (!section || typeof section !== "object") return undefined;
  const value = (section as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

describe("salesforce identity copy", () => {
  it.each(locales)("%s interpolates user and profile into every save identity line", (name, locale) => {
    for (const key of saveIdentityKeys) {
      const value = entry(locale, "grid", key);
      expect(value, `${name} grid.${key} missing`).toBeTypeOf("string");
      expect(value, `${name} grid.${key} must name the user`).toContain("{user}");
      expect(value, `${name} grid.${key} must name the profile`).toContain("{profile}");
    }
    expect(entry(locale, "grid", "salesforceSaveProfile"), `${name} grid.salesforceSaveProfile missing`).toContain("{name}");
  });

  it.each(locales)("%s dropped the admin-blaming save warning", (name, locale) => {
    // The renamed key must not linger: a stale copy invites someone to reuse it.
    expect(entry(locale, "grid", "salesforceSaveNonAdminWarning"), `${name} still ships the old key`).toBeUndefined();
  });

  it.each(locales)("%s explains the non-administrator save case with permissions, not rank", (name, locale) => {
    const value = entry(locale, "grid", "salesforceSaveNonAdminIdentity") ?? "";
    for (const word of adminWords) {
      expect(value.toLowerCase(), `${name} grid.salesforceSaveNonAdminIdentity mentions "${word}"`).not.toContain(word.toLowerCase());
    }
  });

  it.each(locales)("%s attributes the toolbar rights line to the profile", (name, locale) => {
    for (const key of ["salesforceIdentityAdmin", "salesforceIdentityNonAdmin", "salesforceIdentityUnknownRights"] as const) {
      expect(entry(locale, "toolbar", key), `${name} toolbar.${key} missing`).toBeTypeOf("string");
    }
    // `is_admin` is read from `Profile.PermissionsModifyAllData` only, so a
    // permission set can still grant the right: the wording has to stay about
    // the profile, never a flat "this user is not an administrator".
    const nonAdmin = (entry(locale, "toolbar", "salesforceIdentityNonAdmin") ?? "").toLowerCase();
    expect(
      ["profile", "perfil", "简档"].some((word) => nonAdmin.includes(word)),
      `${name} toolbar.salesforceIdentityNonAdmin should scope the claim to the profile`,
    ).toBe(true);
  });

  it("zh-CN translates Profile as 简档, not 配置文件", () => {
    // "配置文件" reads as a config file; Salesforce's Profile is 简档.
    expect(entry(zhCN, "toolbar", "salesforceIdentityUnknownProfile")).toBe("简档未知");
    expect(entry(zhCN, "grid", "salesforceSaveProfile")).toContain("简档");
  });
});
