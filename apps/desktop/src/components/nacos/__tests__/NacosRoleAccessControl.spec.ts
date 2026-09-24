import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosRoleAccessControl.vue", import.meta.url), "utf8");

describe("NacosRoleAccessControl", () => {
  it("keeps the selected role identity when opening the delete dialog", () => {
    expect(source).toContain("resetRoleForm(selectedRole.value.role)");
  });

  it("makes the exact role-name confirmation requirement explicit before deletion", () => {
    expect(source).toContain("const roleDeleteConfirmed = computed(() => roleForm.confirmation === roleForm.role)");
    expect(source).toContain('t("nacos.accessDeleteRoleConfirmationLabel")');
    expect(source).toContain('t("nacos.accessDeleteRoleConfirmationHint")');
    expect(source).toContain("roleDialog === 'delete' && !roleDeleteConfirmed");
  });

  it("requires the exact username before deleting any user", () => {
    expect(source).toContain("const userDeleteConfirmed = computed(() => userForm.confirmation === userForm.username)");
    expect(source).toContain('t("nacos.accessDeleteUserConfirmationLabel")');
    expect(source).toContain('t("nacos.accessDeleteUserConfirmationHint")');
    expect(source).toContain("userDialog === 'delete' && !userDeleteConfirmed");
  });
});
