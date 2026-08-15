import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosRoleAccessControl.vue", import.meta.url), "utf8");

describe("NacosRoleAccessControl", () => {
  it("uses a directory-detail layout for both users and roles", () => {
    expect(source).toContain('class="flex w-64 shrink-0 flex-col border-r');
    expect(source).toContain("v-if=\"tab === 'users'\"");
    expect(source).toContain("v-else-if=\"tab === 'roles' && selectedRole\"");
  });

  it("keeps role creation complete with per-namespace permissions", () => {
    expect(source).toContain("roleForm.newUsers");
    expect(source).toContain("moveNamespacesToGranted");
    expect(source).toContain('action: "rw"');
    expect(source).toContain("setPermissionAction");
    expect(source).toContain("accessUnassignedNamespaces");
    expect(source).toContain("accessGrantedNamespaces");
    expect(source).toContain('kind: "createRole"');
  });

  it("merges split permission rows before editing an existing role", () => {
    expect(source).toContain("mergeNacosNamespacePermissionAssignments(managedRolePermissions.value)");
  });

  it("gates every mutation by its probed operation capability", () => {
    expect(source).toContain("capabilities: NacosAccessControlCapabilities");
    expect(source).toContain("const canCreateUser = computed");
    expect(source).toContain("const canGrantPermission = computed");
    expect(source).toContain("const userOperationWritable = computed");
    expect(source).toContain("const roleOperationWritable = computed");
    expect(source).toContain(':disabled="saving || !userOperationWritable"');
    expect(source).toContain(':disabled="saving || !roleOperationWritable"');
  });

  it("surfaces partial operations instead of hiding them in a toast", () => {
    expect(source).toContain("operationNeedsPasswords");
    expect(source).toContain("nacosRetryAccessOperation");
    expect(source).toContain("nacosUndoAccessOperation");
    expect(source).toContain("accessOperationResult");
  });

  it("renders associated roles with the same navigable card pattern as role members", () => {
    expect(source).toContain('v-if="selectedUser.roles.length" class="flex flex-wrap gap-1.5 rounded border bg-muted/20 p-1.5"');
    expect(source).toContain(":title=\"t('nacos.accessOpenRole', { role })\"");
    expect(source).toContain('@click="openAssociatedRole(role)"');
    expect(source).toContain('emit("select-role")');
  });
});
