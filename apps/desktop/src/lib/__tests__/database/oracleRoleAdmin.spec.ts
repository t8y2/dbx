import { describe, expect, it } from "vitest";
import { directGrantChange, rolePreviewRequest, type OracleRoleChange } from "@/lib/database/oracleRoleAdmin";
import type { OracleGrantSource } from "@/lib/database/oracleSecurity";

const direct: OracleGrantSource = { kind: "object", source: "direct", rolePath: [], grant: { grantee: "User.X", owner: 'Owner."Q', objectName: "表.T", grantor: 'Owner."Q', privilege: "SELECT", grantable: false } };
describe("Oracle role and grant requests", () => {
  it("keeps exact grantee, owner, object and grantor for a direct revoke", () => {
    expect(directGrantChange(direct,"User.X")).toEqual({ action: "revoke", principal: "User.X", kind: "object", privilege: "SELECT", owner: 'Owner."Q', objectName: "表.T", grantor: 'Owner."Q' });
  });
  it("does not turn inherited rights into a direct revoke", () => {
    expect(() => directGrantChange({ ...direct, source: "role", rolePath: ["R"] },"User.X")).toThrow("direct grantee");
    expect(() => directGrantChange({ ...direct, source: "public", grant: { ...direct.grant, grantee: "PUBLIC" } },"User.X")).toThrow();
  });
  it("allows an explicit PUBLIC principal to target its own direct grant", () => {
    expect(directGrantChange({ ...direct, source: "public", grant: { ...direct.grant, grantee: "PUBLIC" } },"PUBLIC").principal).toBe("PUBLIC");
  });
  it("does not broaden a column revoke to the object", () => {
    expect(() => directGrantChange({ ...direct, kind: "column" },"User.X")).toThrow("Column-only");
  });
  it("does not send passwords or unrelated fields to preview", () => {
    const form = { action: "alterRole", principal: "R", authentication: "password", password: "private-role-password", owner: "UNRELATED" } as OracleRoleChange;
    const request = rolePreviewRequest(form);
    expect(request).toEqual({ operation: "preview", change: { action: "alterRole", principal: "R", authentication: "password" } });
    expect(JSON.stringify(request)).not.toContain("private-role-password");
  });
  it("does not apply grantor, columns or grant options to a system revoke", () => {
    const request = rolePreviewRequest({ action: "revoke", principal: "U", kind: "system", privilege: "CREATE SESSION", owner: "O", column: "C", grantor: "G", option: true });
    expect(request.change).toEqual({ action: "revoke", principal: "U", kind: "system", privilege: "CREATE SESSION", option: false });
  });
});
