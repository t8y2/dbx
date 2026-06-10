<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, KeyRound, Lock, Loader2, Plus, RefreshCcw, Search, ShieldCheck, Trash2, Unlock, UserRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/api";
import { grantsFromQueryResult, getDatabaseUserAdminProvider, supportsDatabaseUserAdmin, type DatabaseUserIdentity, type PrivilegeScope } from "@/lib/databaseUserAdmin";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();

const users = ref<DatabaseUserIdentity[]>([]);
const selectedUserKey = ref("");
const grants = ref<string[]>([]);
const search = ref("");
const loadingUsers = ref(false);
const loadingGrants = ref(false);
const applying = ref(false);
const loadError = ref("");
const grantError = ref("");

const createDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const sqlDialogOpen = ref(false);
const pendingSql = ref("");
const pendingDanger = ref(false);
const pendingAfterApply = ref<(() => Promise<void>) | undefined>();

const createUser = ref("app_user");
const createHost = ref("%");
const createPassword = ref("");
const newPassword = ref("");
const privilegeDatabase = ref(props.connection.database || "*");
const privilegeTable = ref("*");
const privilegeScope = ref<PrivilegeScope>("mysql");
const privilegeRole = ref("");
const grantOption = ref(false);
const selectedPrivileges = ref<string[]>(["SELECT"]);
const createCanLogin = ref(true);

const supported = computed(() => supportsDatabaseUserAdmin(props.connection.db_type));
const provider = computed(() => getDatabaseUserAdminProvider(props.connection.db_type));
const isPostgres = computed(() => provider.value?.dialect === "postgres");
const selectedUser = computed(() => users.value.find((user) => userKey(user) === selectedUserKey.value));
const filteredUsers = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => userLabel(user).toLowerCase().includes(query));
});
const selectedPrivilegeSet = computed(() => new Set(selectedPrivileges.value));
const availablePrivileges = computed(() => provider.value?.privilegesForScope(privilegeScope.value) ?? []);
const hasPrivilegePicker = computed(() => privilegeScope.value !== "role");
const loginDisableLabel = computed(() => (isPostgres.value ? t("userAdmin.disableLogin") : t("userAdmin.lock")));
const loginEnableLabel = computed(() => (isPostgres.value ? t("userAdmin.enableLogin") : t("userAdmin.unlock")));
const createNameLabel = computed(() => (isPostgres.value ? t("userAdmin.roleName") : t("userAdmin.username")));
const selectedDetail = computed(() => {
  const user = selectedUser.value;
  return user ? provider.value?.detail(user) || "" : "";
});
const grantsSqlText = computed(() => grants.value.join("\n") || t("userAdmin.noGrants"));
const highlightedGrantsSql = computed(() => highlight(grantsSqlText.value));
const highlightedPendingSql = computed(() => highlight(pendingSql.value));

function userKey(user: DatabaseUserIdentity): string {
  return `${user.user}\u0000${user.host}`;
}

function userLabel(user: DatabaseUserIdentity): string {
  return provider.value?.label(user) ?? user.user;
}

function userDetail(user: DatabaseUserIdentity): string {
  return provider.value?.detail(user) || "";
}

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id);
}

async function loadUsers() {
  const userProvider = provider.value;
  if (!userProvider) return;
  loadingUsers.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    let nextUsers: DatabaseUserIdentity[] = [];
    try {
      const result = await api.executeQuery(props.connection.id, "", userProvider.listUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      nextUsers = userProvider.parseUsers(result);
    } catch (error) {
      if (!userProvider.fallbackListUsersSql || !userProvider.parseFallbackUsers) throw error;
      const fallback = await api.executeQuery(props.connection.id, "", userProvider.fallbackListUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      nextUsers = userProvider.parseFallbackUsers(fallback);
    }
    users.value = nextUsers;
    if (!selectedUser.value) selectedUserKey.value = nextUsers[0] ? userKey(nextUsers[0]) : "";
  } catch (error: any) {
    loadError.value = error?.message || String(error);
  } finally {
    loadingUsers.value = false;
  }
}

async function loadGrants() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider) {
    grants.value = [];
    return;
  }
  loadingGrants.value = true;
  grantError.value = "";
  try {
    const result = await api.executeQuery(props.connection.id, "", userProvider.showGrantsSql(user), undefined, undefined, {
      maxRows: 1000,
    });
    grants.value = grantsFromQueryResult(result);
  } catch (error: any) {
    grantError.value = error?.message || String(error);
    grants.value = [];
  } finally {
    loadingGrants.value = false;
  }
}

function selectUser(user: DatabaseUserIdentity) {
  selectedUserKey.value = userKey(user);
}

function togglePrivilege(privilege: string) {
  const set = new Set(selectedPrivileges.value);
  if (set.has(privilege)) set.delete(privilege);
  else set.add(privilege);
  selectedPrivileges.value = Array.from(set);
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => Promise<void> } = {}) {
  pendingSql.value = sql;
  pendingDanger.value = !!options.danger;
  pendingAfterApply.value = options.afterApply;
  sqlDialogOpen.value = true;
}

async function applyPendingSql() {
  if (!pendingSql.value.trim()) return;
  applying.value = true;
  try {
    await api.executeMulti(props.connection.id, "", pendingSql.value, undefined, undefined, { maxRows: 1000 });
    toast(t("userAdmin.applySuccess"), 2500);
    sqlDialogOpen.value = false;
    await (pendingAfterApply.value?.() ?? Promise.resolve());
    await loadUsers();
    await loadGrants();
  } catch (error: any) {
    toast(t("userAdmin.applyFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    applying.value = false;
  }
}

function previewCreateUser() {
  const userProvider = provider.value;
  if (!userProvider) return;
  if (!createUser.value.trim() || !createPassword.value) return;
  previewSql(
    userProvider.createUserSql({
      user: createUser.value.trim(),
      host: createHost.value.trim() || "%",
      password: createPassword.value,
      canLogin: createCanLogin.value,
    }),
    {
      afterApply: async () => {
        createDialogOpen.value = false;
        createPassword.value = "";
      },
    },
  );
}

function previewPasswordChange() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider || !newPassword.value) return;
  previewSql(userProvider.alterPasswordSql(user, newPassword.value), {
    danger: true,
    afterApply: async () => {
      passwordDialogOpen.value = false;
      newPassword.value = "";
    },
  });
}

function previewDropUser() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider) return;
  previewSql(userProvider.dropUserSql(user), { danger: true });
}

function previewLoginChange(enabled: boolean) {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider) return;
  previewSql(userProvider.alterLoginSql(user, enabled), { danger: true });
}

function previewGrant() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  previewSql(
    userProvider.grantPrivilegesSql({
      user,
      privileges: selectedPrivileges.value,
      database: privilegeDatabase.value,
      table: privilegeTable.value,
      grantOption: grantOption.value,
      scope: privilegeScope.value,
      role: privilegeRole.value,
    }),
  );
}

function previewRevoke() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  previewSql(
    userProvider.revokePrivilegesSql({
      user,
      privileges: selectedPrivileges.value,
      database: privilegeDatabase.value,
      table: privilegeTable.value,
      scope: privilegeScope.value,
      role: privilegeRole.value,
    }),
    { danger: true },
  );
}

function resetPrivilegeDefaults(scope: PrivilegeScope) {
  const userProvider = provider.value;
  if (!userProvider) return;
  selectedPrivileges.value = userProvider.defaultPrivilegesForScope(scope);
  if (userProvider.dialect === "postgres") {
    if (scope === "database") privilegeDatabase.value = props.connection.database || "postgres";
    if (scope === "schema" || scope === "table") privilegeDatabase.value = "public";
    if (scope === "table") privilegeTable.value = "*";
  }
}

watch(
  () => selectedUserKey.value,
  () => void loadGrants(),
);

watch(
  () => props.connection.id,
  () => {
    users.value = [];
    selectedUserKey.value = "";
    grants.value = [];
    privilegeScope.value = provider.value?.defaultScope ?? "mysql";
    resetPrivilegeDefaults(privilegeScope.value);
    void loadUsers();
  },
);

watch(
  () => provider.value?.dialect,
  () => {
    privilegeScope.value = provider.value?.defaultScope ?? "mysql";
    resetPrivilegeDefaults(privilegeScope.value);
  },
  { immediate: true },
);

watch(
  () => privilegeScope.value,
  (scope) => resetPrivilegeDefaults(scope),
);

onMounted(loadUsers);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <div class="flex min-w-0 items-center gap-2">
        <ShieldCheck class="h-4 w-4 text-primary" />
        <div class="truncate text-sm font-semibold">{{ t("userAdmin.title") }}</div>
        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ connection.name }}</Badge>
      </div>
      <div class="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="loadUsers">
          <Loader2 v-if="loadingUsers" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
        <Button size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="!supported" @click="createDialogOpen = true">
          <Plus class="h-3.5 w-3.5" />
          {{ t("userAdmin.newUser") }}
        </Button>
      </div>
    </div>

    <div v-if="!supported" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {{ t("userAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r bg-muted/10">
        <div class="flex h-12 items-center border-b px-2">
          <div class="flex h-8 items-center gap-2 rounded-md border bg-background px-2">
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input v-model="search" class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('userAdmin.searchUser')" />
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="loadingUsers" class="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            {{ t("userAdmin.loadingUsers") }}
          </div>
          <div v-else-if="loadError" class="px-3 py-4 text-xs text-destructive">{{ loadError }}</div>
          <button
            v-for="user in filteredUsers"
            :key="userKey(user)"
            type="button"
            class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 border-b px-3 py-2 text-left text-xs hover:bg-accent"
            :class="{ 'bg-primary/10 text-primary': userKey(user) === selectedUserKey }"
            @click="selectUser(user)"
          >
            <UserRound class="h-4 w-4" />
            <span class="min-w-0">
              <span class="block truncate font-medium">{{ userLabel(user) || t("userAdmin.anonymous") }}</span>
              <span v-if="userDetail(user)" class="mt-1 inline-flex max-w-full rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                <span class="truncate">{{ userDetail(user) }}</span>
              </span>
            </span>
          </button>
          <div v-if="!loadingUsers && !loadError && filteredUsers.length === 0" class="px-3 py-8 text-center text-xs text-muted-foreground">
            {{ t("grid.noSearchResults") }}
          </div>
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="selectedUser" class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UserRound class="h-4 w-4" />
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <div class="truncate text-sm font-semibold">{{ userLabel(selectedUser) }}</div>
            <Badge v-if="selectedDetail" variant="outline" class="h-5 max-w-[180px] rounded-full px-2 py-0 text-[10px] font-normal">
              <span class="truncate">{{ selectedDetail }}</span>
            </Badge>
          </div>
          <div class="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="passwordDialogOpen = true">
              <KeyRound class="h-3.5 w-3.5" />
              {{ t("userAdmin.changePassword") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(false)">
              <Lock class="h-3.5 w-3.5" />
              {{ loginDisableLabel }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(true)">
              <Unlock class="h-3.5 w-3.5" />
              {{ loginEnableLabel }}
            </Button>
            <Button variant="destructive" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewDropUser">
              <Trash2 class="h-3.5 w-3.5" />
              {{ t("userAdmin.dropUser") }}
            </Button>
          </div>
        </div>

        <div v-if="selectedUser" class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
          <section class="flex min-h-0 flex-col border-r">
            <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3 text-xs font-medium">
              <ShieldCheck class="h-3.5 w-3.5" />
              {{ t("userAdmin.grants") }}
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3">
              <div v-if="loadingGrants" class="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 class="h-3.5 w-3.5 animate-spin" />
                {{ t("userAdmin.loadingGrants") }}
              </div>
              <div v-else-if="grantError" class="text-xs text-destructive">{{ grantError }}</div>
              <pre v-else class="min-h-full whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground" v-html="highlightedGrantsSql" />
            </div>
          </section>

          <aside class="flex min-h-0 flex-col bg-muted/10">
            <div class="border-b p-3">
              <div class="text-xs font-semibold">{{ t("userAdmin.privilegeEditor") }}</div>
              <div class="mt-1 text-[11px] leading-4 text-muted-foreground">{{ t("userAdmin.privilegeHint") }}</div>
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3">
              <template v-if="isPostgres">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.scope") }}</label>
                <Select v-model="privilegeScope">
                  <SelectTrigger class="mb-3 h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="database">{{ t("userAdmin.scopeDatabase") }}</SelectItem>
                    <SelectItem value="schema">{{ t("userAdmin.scopeSchema") }}</SelectItem>
                    <SelectItem value="table">{{ t("userAdmin.scopeTable") }}</SelectItem>
                    <SelectItem value="role">{{ t("userAdmin.scopeRole") }}</SelectItem>
                  </SelectContent>
                </Select>
              </template>

              <template v-if="privilegeScope === 'role'">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.memberRole") }}</label>
                <Input v-model="privilegeRole" class="mb-3 h-8 text-xs" :placeholder="t('userAdmin.memberRole')" />
              </template>
              <template v-else>
                <label class="mb-2 block text-xs font-medium">
                  {{ isPostgres && privilegeScope !== "database" ? t("userAdmin.schema") : t("userAdmin.database") }}
                </label>
                <Input v-model="privilegeDatabase" class="mb-3 h-8 text-xs" :placeholder="isPostgres ? 'public' : '*'" />
                <template v-if="!isPostgres || privilegeScope === 'table'">
                  <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.table") }}</label>
                  <Input v-model="privilegeTable" class="mb-3 h-8 text-xs" placeholder="*" />
                </template>
              </template>

              <div v-if="hasPrivilegePicker" class="mb-2 text-xs font-medium">{{ t("userAdmin.privileges") }}</div>
              <div v-if="hasPrivilegePicker" class="grid grid-cols-2 gap-1.5">
                <button
                  v-for="privilege in availablePrivileges"
                  :key="privilege"
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-md border px-2 text-left text-[11px] hover:bg-accent"
                  :class="selectedPrivilegeSet.has(privilege) ? 'border-primary bg-primary/10 text-primary' : 'bg-background'"
                  @click="togglePrivilege(privilege)"
                >
                  <span class="flex h-3.5 w-3.5 items-center justify-center rounded border" :class="selectedPrivilegeSet.has(privilege) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'">
                    <Check v-if="selectedPrivilegeSet.has(privilege)" class="h-2.5 w-2.5" />
                  </span>
                  <span class="truncate">{{ privilege }}</span>
                </button>
              </div>
              <label class="mt-3 flex items-center gap-2 text-xs">
                <input v-model="grantOption" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
                {{ privilegeScope === "role" ? t("userAdmin.adminOption") : t("userAdmin.grantOption") }}
              </label>
            </div>
            <div class="flex shrink-0 items-center justify-end gap-2 border-t p-3">
              <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="previewRevoke">
                {{ t("userAdmin.revoke") }}
              </Button>
              <Button size="sm" class="h-7 px-2 text-xs" @click="previewGrant">
                {{ t("userAdmin.grant") }}
              </Button>
            </div>
          </aside>
        </div>

        <div v-else class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {{ t("userAdmin.emptyUsers") }}
        </div>
      </main>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.newUser") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <label class="block text-xs font-medium">{{ createNameLabel }}</label>
          <Input v-model="createUser" />
          <template v-if="!isPostgres">
            <label class="block text-xs font-medium">{{ t("userAdmin.host") }}</label>
            <Input v-model="createHost" />
          </template>
          <label v-else class="flex items-center gap-2 text-xs">
            <input v-model="createCanLogin" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
            {{ t("userAdmin.allowLogin") }}
          </label>
          <label class="block text-xs font-medium">{{ t("connection.password") }}</label>
          <Input v-model="createPassword" type="password" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!createUser.trim() || !createPassword" @click="previewCreateUser">
            {{ t("userAdmin.previewSql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="passwordDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.changePassword") }}</DialogTitle>
        </DialogHeader>
        <Input v-model="newPassword" type="password" :placeholder="t('userAdmin.newPassword')" />
        <DialogFooter>
          <Button variant="outline" @click="passwordDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!newPassword" @click="previewPasswordChange">{{ t("userAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="sqlDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle v-if="pendingDanger" class="h-4 w-4 text-destructive" />
            {{ t("userAdmin.sqlPreview") }}
          </DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] min-h-44 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5" v-html="highlightedPendingSql" />
        <DialogFooter>
          <Button variant="outline" @click="sqlDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
            <Loader2 v-if="applying" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("userAdmin.applySql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
