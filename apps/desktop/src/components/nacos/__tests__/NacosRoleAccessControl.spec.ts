import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosRoleAccessControl.vue", import.meta.url), "utf8");

describe("NacosRoleAccessControl", () => {
  it("uses a directory-detail layout for both users and roles", () => {
    expect(source).toContain('class="flex w-64 shrink-0 flex-col border-r');
    expect(source).toContain("v-if=\"tab === 'users'\"");
    expect(source).toContain("v-else-if=\"tab === 'roles' && selectedRole\"");
  });

  it("places the contextual create action beside search instead of duplicating refresh", () => {
    expect(source).toContain(":aria-label=\"tab === 'users' ? t('nacos.createUser') : t('nacos.accessCreateRole')\"");
    expect(source).toContain("@click=\"tab === 'users' ? openCreateUser() : openCreateRole()\"");
    expect(source).toContain("<UserPlus v-if=\"tab === 'users'\"");
    expect(source).toContain("<ShieldPlus v-else");
    expect(source).not.toContain(":aria-label=\"t('nacos.refresh')\"");
    expect(source).not.toContain('class="h-8 w-full"');
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

  it("lets the backend workflow protect only the final ROLE_ADMIN member", () => {
    expect(source).toContain("if (!selectedUser.value) return");
    expect(source).not.toContain('selectedUser.value.roles.includes("ROLE_ADMIN")');
    expect(source).not.toContain("v-if=\"!selectedUser.roles.includes('ROLE_ADMIN')\"");
  });

  it("shows complete IDs only in the unassigned namespace list", () => {
    expect(source).toContain('class="block truncate font-medium" :title="namespace.name"');
    expect(source).toContain('class="block break-all text-[10px] leading-4 text-muted-foreground" :title="namespace.id"');
    expect(source).not.toContain('<code v-if="namespace.name !== namespace.namespaceId"');
  });

  it("uses a wider, internally scrollable namespace picker and filters by name or ID", () => {
    expect(source).toContain('class="max-h-[90vh] overflow-auto sm:max-w-3xl"');
    expect(source).toContain("h-[min(28rem,45vh)]");
    expect(source).toContain('const id = item.id ?? item.namespaceId ?? ""');
    expect(source).toContain("item.name.toLocaleLowerCase().includes(normalized) || id.toLocaleLowerCase().includes(normalized)");
    expect(source).toContain(":aria-label=\"t('nacos.accessSearchNamespaces')\"");
  });

  it("refreshes the role namespace options after a namespace change for this connection", () => {
    expect(source).toContain('import { subscribeNacosNamespacesChanged, type NacosNamespacesChangedDetail } from "@/lib/nacos/nacosNamespaceCache"');
    expect(source).toContain("function handleNacosNamespacesChanged(detail: NacosNamespacesChangedDetail)");
    expect(source).toContain("if (detail.connectionId === props.connectionId) void loadSnapshot()");
    expect(source).toContain("stopNacosNamespacesChangedListener = subscribeNacosNamespacesChanged(handleNacosNamespacesChanged)");
    expect(source).toContain("stopNacosNamespacesChangedListener?.()");
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
    expect(source).toContain(':disabled="saving || !userOperationWritable ||');
    expect(source).toContain(':disabled="saving || !roleOperationWritable ||');
  });

  it("surfaces partial operations instead of hiding them in a toast", () => {
    expect(source).toContain("operationNeedsPasswords");
    expect(source).toContain("nacosRetryAccessOperation");
    expect(source).toContain("nacosUndoAccessOperation");
    expect(source).toContain("accessOperationResult");
  });

  it("uses the global notification for password reset results", () => {
    expect(source).toContain('import { useToast } from "@/composables/useToast"');
    expect(source).toContain("const { toast } = useToast()");
    expect(source).toContain('toast(t("nacos.passwordResetSucceeded", { username }), 2500)');
    expect(source).toContain('toast(t("nacos.passwordResetFailed", { message }), 5000)');
  });

  it("renders associated roles with the same navigable card pattern as role members", () => {
    expect(source).toContain('v-if="selectedUser.roles.length" class="flex flex-wrap gap-1.5 rounded border bg-muted/20 p-1.5"');
    expect(source).toContain(":title=\"t('nacos.accessOpenRole', { role })\"");
    expect(source).toContain('@click="openAssociatedRole(role)"');
    expect(source).toContain('emit("select-role")');
  });
});
