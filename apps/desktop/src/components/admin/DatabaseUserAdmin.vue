<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Globe2, KeyRound, Lock, Loader2, Plus, RefreshCcw, Search, ShieldCheck, Trash2, Unlock, UserRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AuthorizationScopeEditor from "@/components/admin/AuthorizationScopeEditor.vue";
import OracleSecurityDetails from "@/components/admin/OracleSecurityDetails.vue";
import { buildOracleObjectAuthorizationPlan, createOracleUserAdminActions, oracleGrantObjectsSql, oraclePrivilegesForScope } from "@/lib/database/oracleUserAdmin";
import { loadOracleSecurity, supportsOracleSecurity, ORACLE_SECURITY_ROW_LIMIT, oracleWriteRejected, parseOracleErrorCode, type OracleSecuritySnapshot } from "@/lib/database/oracleSecurity";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { fetchNamespaceOptionsForConnection } from "@/composables/useDatabaseOptions";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { grantsFromQueryResult, normalizeStarrocksCatalog, resolveDatabaseUserAdminProviderForConnection, type DatabaseTablePrivilegeGrant, type DatabaseUserIdentity, type PrivilegeScope } from "@/lib/database/databaseUserAdmin";
import {
  authorizationPlanSql,
  authorizationPlanStatus,
  authorizationPresetPrivileges,
  authorizationPrivileges,
  buildCreateUserAuthorizationPlan,
  buildGrantAuthorizationPlan,
  databaseAuthorizationsFromTableGrants,
  executeAuthorizationPlan,
  type AuthorizationAccountType,
  type AuthorizationDatabaseOption,
  type AuthorizationPlan,
  type AuthorizationStepResult,
  type DatabaseAuthorizationSelection,
} from "@/lib/database/databaseAuthorizationPlan";
import { useTabUiState } from "@/lib/tabs/tabUiState";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();

interface DatabaseUserAdminTabUiState {
  selectedUserKey?: string;
  search?: string;
  privilegeDatabase?: string;
  privilegeTable?: string;
  privilegeScope?: PrivilegeScope;
  privilegeRole?: string;
  grantOption?: boolean;
  selectedPrivileges?: string[];
}

const { initialState: restoredUiState, track: trackUiState } = useTabUiState<DatabaseUserAdminTabUiState>({}, "DatabaseUserAdmin");
const privilegeScopes: PrivilegeScope[] = ["mysql", "database", "schema", "table", "role", "system"];
const users = ref<DatabaseUserIdentity[]>([]);
const selectedUserKey = ref(restoredUiState.selectedUserKey ?? "");
const grants = ref<string[]>([]);
const grantsLoaded = ref(false);
const search = ref(restoredUiState.search ?? "");
const loadingUsers = ref(false);
const loadingGrants = ref(false);
const applying = ref(false);
const preparingCreatePlan = ref(false);
const loadError = ref("");
const grantError = ref("");
const oracleSnapshot = ref<OracleSecuritySnapshot>();
let usersRequestId = 0;
let grantsRequestId = 0;

const createDialogOpen = ref(false);
const hostDialogOpen = ref(false);
const passwordDialogOpen = ref(false);
const sqlDialogOpen = ref(false);
const pendingSql = ref("");
const pendingDisplaySql = ref("");
let previewGeneration = 0;
const pendingPlan = ref<AuthorizationPlan>();
const pendingResults = ref<AuthorizationStepResult[]>([]);
const pendingDanger = ref(false);
const pendingAfterApply = ref<(() => Promise<void>) | undefined>();
const pendingPasswordChange = ref<{ connectionId: string; selfChange: boolean }>();
const passwordReconnectRequired = ref(false);
const passwordCleanupFailed = ref(false);
const passwordRetirement = ref<{ id: number; identity: string; subjectKey: string; retiredIdentity: string; retiring: boolean }>();
let passwordRetirementId = 0;
interface OracleExecution {
  id: number;
  identity: string;
  subjectKey: string;
  targetLabel: string;
  plan: AuthorizationPlan;
  displaySql: string;
  stopRequested: boolean;
  settled: boolean;
  retiring?: boolean;
  retiringIdentity?: string;
  dispatchedStepIds: Set<string>;
  rejectedStepIds: Set<string>;
  results: AuthorizationStepResult[];
}
const oracleExecution = ref<OracleExecution>();
let oracleExecutionId = 0;
const oracleVisibleSql = computed(() => oracleExecution.value?.displaySql ?? (pendingDisplaySql.value || pendingSql.value));
const oracleExecutionStatus = computed(() => {
  const execution = oracleExecution.value;
  if (!execution) return "";
  if (!execution.settled) return execution.stopRequested && execution.dispatchedStepIds.size > 0 ? t("oracleSecurity.stoppingAwaitingResult") : t("common.pending");
  if (execution.stopRequested) return t("oracleSecurity.stoppedFollowing");
  return "";
});
const visibleResults = computed(() => oracleExecution.value?.results ?? pendingResults.value);
const visibleStatus = computed(() => {
  if (!visibleResults.value.length) return undefined;
  return authorizationPlanStatus(visibleResults.value);
});

const createUser = ref("app_user");
const createHost = ref("%");
const createPassword = ref("");
const newHost = ref("");
const newPassword = ref("");
const oldPassword = ref("");
const privilegeDatabase = ref(restoredUiState.privilegeDatabase ?? (props.connection.database || "*"));
const privilegeTable = ref(restoredUiState.privilegeTable ?? "*");
const privilegeScope = ref<PrivilegeScope>(privilegeScopes.includes(restoredUiState.privilegeScope as PrivilegeScope) ? restoredUiState.privilegeScope! : "mysql");
const privilegeRole = ref(restoredUiState.privilegeRole ?? "");
const grantOption = ref(restoredUiState.grantOption ?? false);
const selectedPrivileges = ref<string[]>(restoredUiState.selectedPrivileges ?? ["SELECT"]);
const createCanLogin = ref(true);
const createAccountType = ref<AuthorizationAccountType>("standard");
const createDatabases = ref<AuthorizationDatabaseOption[]>([]);
const createDatabasesLoading = ref(false);
const createDatabasesLoadError = ref("");
const createDatabaseAuthorizations = ref<DatabaseAuthorizationSelection[]>([]);
// 权限编辑面板的授权范围选择，与新增用户弹窗复用同一个范围编辑器
const privilegeAuthorizations = ref<DatabaseAuthorizationSelection[]>([]);
const currentTableGrants = ref<DatabaseTablePrivilegeGrant[]>([]);
const currentTableGrantsLoaded = ref(false);
const currentTableGrantsLoading = ref(false);
const tableGrantLoadError = ref("");
let createPlanRequestId = 0;
let tableGrantRequestId = 0;
let databaseLoadPromise: Promise<void> | undefined;
let databaseRequestId = 0;
let preserveRestoredPrivilegeSelection = restoredUiState.selectedPrivileges !== undefined || restoredUiState.grantOption !== undefined;

trackUiState(() => ({
  selectedUserKey: selectedUserKey.value,
  search: search.value,
  privilegeDatabase: privilegeDatabase.value,
  privilegeTable: privilegeTable.value,
  privilegeScope: privilegeScope.value,
  privilegeRole: privilegeRole.value,
  grantOption: grantOption.value,
  selectedPrivileges: selectedPrivileges.value,
}));

const provider = computed(() => resolveDatabaseUserAdminProviderForConnection(props.connection));
const connectionIdentity = computed(() => `${props.connection.id}:${connectionConfigFingerprint(props.connection)}`);
const isOracle = computed(() => supportsOracleSecurity(props.connection));
const supported = computed(() => provider.value !== null || isOracle.value);
const isPostgres = computed(() => provider.value?.dialect === "postgres");
const actions = computed(() => (isOracle.value ? createOracleUserAdminActions(oracleSnapshot.value, selectedUser.value?.user, effectiveDatabaseTypeForConnection(props.connection) === "oracle") : provider.value));
const canCreateUser = computed(() => !!provider.value?.createUserSql);
const canRenameUser = computed(() => !!provider.value?.renameUserSql);
const canAlterPassword = computed(() => !!actions.value?.alterPasswordSql);
const canAlterLogin = computed(() => !!actions.value?.alterLoginSql);
const canDropUser = computed(() => !!provider.value?.dropUserSql);
const canGrantPrivileges = computed(() => !!actions.value?.grantPrivilegesSql);
const canRevokePrivileges = computed(() => !!actions.value?.revokePrivilegesSql);
const canEditPrivileges = computed(() => canGrantPrivileges.value || canRevokePrivileges.value);
const supportsCreateTableGrants = computed(() => !!provider.value?.supportsTableGrantsOnCreate);
const selectedUser = computed(() => users.value.find((user) => userKey(user) === selectedUserKey.value));
const filteredUsers = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => userLabel(user).toLowerCase().includes(query));
});
const selectedPrivilegeSet = computed(() => new Set(selectedPrivileges.value));
const availablePrivileges = computed(() => (isOracle.value ? oraclePrivilegesForScope(privilegeScope.value) : (provider.value?.privilegesForScope?.(privilegeScope.value) ?? [])));
const oracleGrantOptionAllowed = computed(() => selectedUser.value?.user !== "PUBLIC" && (privilegeScope.value !== "table" || !oracleSnapshot.value?.roles.rows.some((role) => role.name === selectedUser.value?.user)));
const hasPrivilegePicker = computed(() => privilegeScope.value !== "role");
const loginDisableLabel = computed(() => (isPostgres.value ? t("userAdmin.disableLogin") : t("userAdmin.lock")));
const loginEnableLabel = computed(() => (isPostgres.value ? t("userAdmin.enableLogin") : t("userAdmin.unlock")));
const createNameLabel = computed(() => (isPostgres.value ? t("userAdmin.roleName") : t("userAdmin.username")));
const selectedDetail = computed(() => {
  const user = selectedUser.value;
  return user ? userDetail(user) : "";
});
const grantsSqlText = computed(() => grants.value.join("\n") || t("userAdmin.noGrants"));
const highlightedGrantsSql = computed(() => highlight(grantsSqlText.value));
const createDatabaseAuthorizationsValid = computed(() => authorizationSelectionsValid(createDatabaseAuthorizations.value));
const usePrivilegeScopeEditor = computed(() => canEditPrivileges.value && (isOracle.value ? privilegeScope.value === "table" : supportsCreateTableGrants.value && privilegeScope.value !== "role" && (provider.value?.authorizationModel !== "postgres" || privilegeScope.value === "table")));
const oracleObjectScope = computed(() => {
  if (!isOracle.value) return undefined;
  const connectionId = props.connection.id;
  return {
    privileges: oraclePrivilegesForScope("table"),
    async loadObjects(owner: string) {
      const result = await api.executeQuery(connectionId, "", oracleGrantObjectsSql(owner), undefined, undefined, { maxRows: ORACLE_SECURITY_ROW_LIMIT });
      if (result.execution_error) throw new Error(t("oracleSecurity.error"));
      if (result.truncated || result.has_more || result.rows.length >= ORACLE_SECURITY_ROW_LIMIT) throw new Error(t("oracleSecurity.truncated"));
      return result.rows.map((row) => ({ name: String(row[0]), objectType: String(row[1]) }));
    },
  };
});
const privilegeAuthorizationsValid = computed(() => authorizationSelectionsValid(privilegeAuthorizations.value));
const tableGrantDiffReady = computed(() => isOracle.value || provider.value?.authorizationModel === "mysql" || currentTableGrantsLoaded.value);
const canPreviewHostChange = computed(() => {
  const host = newHost.value.trim();
  return !!host && host !== selectedUser.value?.host;
});

function syncPrivilegeSelectionFromGrants() {
  const selectionFromGrants = provider.value?.privilegeSelectionFromGrants;
  if (!grantsLoaded.value || !selectionFromGrants) return;
  if (preserveRestoredPrivilegeSelection) {
    preserveRestoredPrivilegeSelection = false;
    return;
  }
  const selection = selectionFromGrants({
    grants: grants.value,
    database: privilegeDatabase.value,
    table: privilegeTable.value,
    availablePrivileges: availablePrivileges.value,
  });
  selectedPrivileges.value = selection.privileges;
  grantOption.value = selection.grantOption;
}

function userKey(user: DatabaseUserIdentity): string {
  return `${user.user}\u0000${user.host}`;
}

function userLabel(user: DatabaseUserIdentity): string {
  if (isOracle.value && !user.user) return t("oracleSecurity.all");
  return provider.value?.label(user) ?? user.user;
}

function userDetail(user: DatabaseUserIdentity): string {
  if (isOracle.value) {
    if (oracleSnapshot.value?.roles.rows.some((role) => role.name === user.user)) return t("oracleSecurity.role");
    const account = oracleSnapshot.value?.users.rows.find((row) => row.name === user.user);
    return account ? account.accountStatus || t("oracleSecurity.accountUnavailable") : "";
  }
  return provider.value?.detail(user) || "";
}

async function loadUsers() {
  if (passwordReconnectRequired.value) return;
  const userProvider = provider.value;
  const oracle = isOracle.value;
  if (!userProvider && !oracle) return;
  const connection = { ...props.connection };
  const identity = connectionIdentity.value;
  const request = ++usersRequestId;
  const current = () => request === usersRequestId && identity === connectionIdentity.value;
  loadingUsers.value = true;
  loadError.value = "";
  oracleSnapshot.value = undefined;
  if (oracle) users.value = [];
  try {
    await connectionStore.ensureConnected(connection.id, { skipIfClosedByUser: true });
    if (!current() || passwordReconnectRequired.value) return;
    if (oracle) {
      const snapshot = await loadOracleSecurity((sql) => {
        if (!current()) throw new Error("Request superseded");
        return api.executeQuery(connection.id, "", sql, undefined, undefined, { maxRows: ORACLE_SECURITY_ROW_LIMIT });
      }, connection);
      if (!current()) return;
      oracleSnapshot.value = snapshot;
      const names = new Set([...snapshot.currentUser.rows, ...snapshot.users.rows.map((user) => user.name), ...snapshot.roles.rows.map((role) => role.name), "PUBLIC"]);
      users.value = [...names].filter(Boolean).map((user) => ({ user, host: "" }));
      users.value.push({ user: "", host: "" });
      if (!selectedUser.value) selectedUserKey.value = userKey(users.value[0]);
      return;
    }
    if (!userProvider) return;
    let nextUsers: DatabaseUserIdentity[] = [];
    try {
      const result = await api.executeQuery(connection.id, "", userProvider.listUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      if (!current()) return;
      nextUsers = userProvider.parseUsers(result);
    } catch (error) {
      if (!current()) return;
      if (!userProvider.fallbackListUsersSql || !userProvider.parseFallbackUsers) throw error;
      const fallback = await api.executeQuery(connection.id, "", userProvider.fallbackListUsersSql(), undefined, undefined, {
        maxRows: 5000,
      });
      if (!current()) return;
      nextUsers = userProvider.parseFallbackUsers(fallback);
    }
    users.value = nextUsers;
    if (!selectedUser.value) selectedUserKey.value = nextUsers[0] ? userKey(nextUsers[0]) : "";
  } catch (error: any) {
    if (current()) loadError.value = error?.message || String(error);
  } finally {
    if (current()) loadingUsers.value = false;
  }
}

async function loadGrants() {
  if (passwordReconnectRequired.value) return;
  const user = selectedUser.value;
  const userProvider = provider.value;
  const connectionId = props.connection.id;
  const identity = connectionIdentity.value;
  const request = ++grantsRequestId;
  const current = () => request === grantsRequestId && identity === connectionIdentity.value && !!user && userKey(user) === selectedUserKey.value;
  grantError.value = "";
  if (!user || !userProvider) {
    grants.value = [];
    grantsLoaded.value = false;
    loadingGrants.value = false;
    return;
  }
  loadingGrants.value = true;
  grantsLoaded.value = false;
  grantError.value = "";
  if (userProvider.authorizationModel !== "mysql") {
    currentTableGrants.value = [];
    currentTableGrantsLoaded.value = false;
    currentTableGrantsLoading.value = false;
    tableGrantLoadError.value = "";
  }
  try {
    const result = await api.executeQuery(connectionId, "", userProvider.showGrantsSql(user), undefined, undefined, {
      maxRows: 1000,
    });
    if (!current()) return;
    grants.value = (userProvider.parseGrants ?? grantsFromQueryResult)(result);
    grantsLoaded.value = true;
    if (userProvider.tableGrantsFromShowGrants && userProvider.parseTableGrants) {
      currentTableGrants.value = userProvider.parseTableGrants(result);
      currentTableGrantsLoaded.value = true;
      tableGrantLoadError.value = "";
      syncAuthorizationSelectionsFromTableGrants();
    }
    // Existing-user editing reflects the exact SHOW GRANTS scope; create-user defaults stay independent.
    syncPrivilegeSelectionFromGrants();
    if (userProvider.authorizationModel === "postgres" && usePrivilegeScopeEditor.value) await loadCurrentTableGrants();
  } catch (error: any) {
    if (!current()) return;
    grantError.value = error?.message || String(error);
    grants.value = [];
    grantsLoaded.value = false;
    currentTableGrants.value = [];
    currentTableGrantsLoaded.value = false;
  } finally {
    if (current()) loadingGrants.value = false;
  }
}

async function loadCurrentTableGrants() {
  if (passwordReconnectRequired.value) return;
  const user = selectedUser.value;
  const userProvider = provider.value;
  if (!user || !userProvider?.tableGrantsSql || !userProvider.parseTableGrants || currentTableGrantsLoading.value) return;
  const requestId = ++tableGrantRequestId;
  const identity = connectionIdentity.value;
  const connectionId = props.connection.id;
  const selectedKey = userKey(user);
  currentTableGrantsLoading.value = true;
  currentTableGrantsLoaded.value = false;
  tableGrantLoadError.value = "";
  try {
    if (createDatabases.value.length === 0) await loadDatabases();
    if (createDatabasesLoadError.value) throw new Error(createDatabasesLoadError.value);
    const grantsByDatabase = await Promise.all(
      createDatabases.value.map(async ({ database }) => {
        const result = await api.executeQuery(connectionId, database, userProvider.tableGrantsSql!(user), undefined, undefined, { maxRows: 10000 });
        return userProvider.parseTableGrants!(result, { database });
      }),
    );
    if (requestId !== tableGrantRequestId || identity !== connectionIdentity.value || selectedUserKey.value !== selectedKey) return;
    currentTableGrants.value = grantsByDatabase.flat();
    currentTableGrantsLoaded.value = true;
    syncAuthorizationSelectionsFromTableGrants();
  } catch (error: any) {
    if (requestId !== tableGrantRequestId || identity !== connectionIdentity.value || selectedUserKey.value !== selectedKey) return;
    currentTableGrants.value = [];
    currentTableGrantsLoaded.value = false;
    tableGrantLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === tableGrantRequestId && identity === connectionIdentity.value) currentTableGrantsLoading.value = false;
  }
}

function syncAuthorizationSelectionsFromTableGrants() {
  const userProvider = provider.value;
  if (!userProvider || createDatabases.value.length === 0 || privilegeAuthorizations.value.length > 0) return;
  const loaded = databaseAuthorizationsFromTableGrants(userProvider, currentTableGrants.value);
  const available = new Map(createDatabases.value.map((option) => [authorizationDatabaseOptionKey(option), option]));
  const selections = loaded.selections.flatMap((selection) => {
    const option = available.get(authorizationDatabaseOptionKey(selection));
    if (!option) return [];
    return [{ ...selection, catalog: option.catalog }];
  });
  privilegeAuthorizations.value = selections;
  if (selections.length > 0) grantOption.value = loaded.grantOption;
}

function authorizationDatabaseOptionKey(option: AuthorizationDatabaseOption): string {
  const catalog = provider.value?.authorizationModel === "starrocks" ? (normalizeStarrocksCatalog(option.catalog ?? "") ?? "default_catalog") : (option.catalog ?? "");
  return JSON.stringify([catalog, option.database]);
}

async function preparePrivilegeScopeEditor() {
  if (createDatabases.value.length === 0) await loadDatabases();
  if (provider.value?.authorizationModel === "postgres" && !currentTableGrantsLoaded.value) await loadCurrentTableGrants();
}

function selectUser(user: DatabaseUserIdentity) {
  selectedUserKey.value = userKey(user);
}

function openHostDialog() {
  const user = selectedUser.value;
  if (!user || !provider.value?.renameUserSql) return;
  newHost.value = user.host;
  hostDialogOpen.value = true;
}

function togglePrivilege(privilege: string) {
  const set = new Set(selectedPrivileges.value);
  if (set.has(privilege)) set.delete(privilege);
  else set.add(privilege);
  selectedPrivileges.value = Array.from(set);
}

// 加载当前连接下的数据库列表：新增用户弹窗与权限编辑面板的授权范围编辑器共用
function loadDatabases(): Promise<void> {
  if (passwordReconnectRequired.value) return Promise.resolve();
  if (databaseLoadPromise) return databaseLoadPromise;
  let request!: Promise<void>;
  const config = { ...props.connection };
  const identity = connectionIdentity.value;
  const generation = ++databaseRequestId;
  const current = () => identity === connectionIdentity.value && generation === databaseRequestId;
  request = (async () => {
    createDatabases.value = [];
    createDatabasesLoading.value = true;
    createDatabasesLoadError.value = "";
    try {
      await connectionStore.ensureConnected(config.id, { skipIfClosedByUser: true });
      if (!current() || passwordReconnectRequired.value) return;
      if (provider.value?.authorizationModel === "starrocks") {
        const catalogs = await api.listDorisCatalogs(config.id);
        if (catalogs.length > 0) {
          const catalogDatabases = await Promise.all(catalogs.map(async (catalog) => (await api.listDorisCatalogDatabases(config.id, catalog.name)).map((database) => ({ catalog: catalog.name, database: database.name }))));
          if (!current()) return;
          createDatabases.value = catalogDatabases.flat();
        } else {
          const databases = await api.listDatabases(config.id);
          if (!current()) return;
          createDatabases.value = databases.map((database) => ({ database: database.name }));
        }
      } else {
        const databases = config.db_type === "dameng" || supportsOracleSecurity(config) ? await fetchNamespaceOptionsForConnection(config.id, config) : (await api.listDatabases(config.id)).map((database) => database.name);
        if (!current()) return;
        createDatabases.value = databases.map((database) => ({ database }));
      }
      if (currentTableGrantsLoaded.value) syncAuthorizationSelectionsFromTableGrants();
    } catch (error: any) {
      if (!current()) return;
      createDatabasesLoadError.value = error?.message || String(error);
      toast(t("userAdmin.loadDatabasesFailed", { message: createDatabasesLoadError.value }), 5000);
    } finally {
      if (current()) createDatabasesLoading.value = false;
      if (databaseLoadPromise === request) databaseLoadPromise = undefined;
    }
  })();
  databaseLoadPromise = request;
  return request;
}

async function openCreateUserDialog() {
  createDialogOpen.value = true;
  createAccountType.value = "standard";
  createCanLogin.value = true;
  createPassword.value = "";
  createDatabaseAuthorizations.value = [];
  await loadDatabases();
}

/**
 * 校验授权选择是否可生成语句：指定表时必须至少选一张表；自定义权限时必须命中至少一项可用权限。
 * 表级与库级可用权限不同（例如 MySQL 表级不支持 CREATE ROUTINE / EVENT），因此按选择的目标作用域取权限集合。
 */
function authorizationSelectionsValid(selections: DatabaseAuthorizationSelection[]): boolean {
  if (isOracle.value) {
    if (!selections.length) return false;
    try {
      buildOracleObjectAuthorizationPlan(actions.value!, selectedUser.value?.user ?? "", selections, grantOption.value);
      return true;
    } catch {
      return false;
    }
  }
  const userProvider = provider.value;
  if (!userProvider) return false;
  return selections.every((selection) => {
    if (selection.tables !== undefined && selection.tables.length === 0) return false;
    const targetScope = selection.tables === undefined && userProvider.authorizationModel !== "starrocks" ? "database" : "table";
    const available = authorizationPrivileges(userProvider, targetScope);
    if (selection.preset !== "custom") return authorizationPresetPrivileges(userProvider, selection.preset, selection.privileges, targetScope).length > 0;
    return available.some((privilege) => selection.privileges?.includes(privilege));
  });
}

async function prepareAuthorizationSelections(selections: DatabaseAuthorizationSelection[]): Promise<DatabaseAuthorizationSelection[]> {
  if (provider.value?.authorizationModel !== "postgres") return selections;
  return Promise.all(
    selections.map(async (selection) => ({
      ...selection,
      schemas: selection.tables === undefined ? await api.listSchemas(props.connection.id, selection.database) : Array.from(new Set(selection.tables.flatMap((table) => (table.schema ? [table.schema] : [])))),
    })),
  );
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => Promise<void> } = {}) {
  if (oracleExecution.value?.settled) oracleExecution.value = undefined;
  previewGeneration++;
  pendingDisplaySql.value = "";
  pendingPasswordChange.value = undefined;
  pendingSql.value = sql;
  pendingPlan.value = undefined;
  pendingResults.value = [];
  pendingDanger.value = !!options.danger;
  pendingAfterApply.value = options.afterApply;
  sqlDialogOpen.value = true;
}

function previewGeneratedSql(build: () => string, options: { danger?: boolean; afterApply?: () => Promise<void> } = {}): boolean {
  try {
    previewSql(build(), options);
    return true;
  } catch (error) {
    toast(t("userAdmin.applyFailed", { message: String(error) }), 5000);
    return false;
  }
}

async function applyPendingSql() {
  if (!pendingSql.value.trim() || applying.value || passwordReconnectRequired.value) return;
  if (oracleExecution.value && !oracleExecution.value.settled) return;
  const sql = pendingSql.value;
  const plan = pendingPlan.value;
  const afterApply = pendingAfterApply.value;
  const passwordChange = pendingPasswordChange.value;
  const connection = props.connection;
  const identity = connectionIdentity.value;
  const subjectKey = selectedUserKey.value;
  const generation = previewGeneration;
  const oracleAction = isOracle.value;
  let activeRetirementId: number | undefined;
  const execution: OracleExecution | undefined = oracleAction
    ? reactive<OracleExecution>({
        id: ++oracleExecutionId,
        identity,
        subjectKey,
        targetLabel: `${connection.name} · ${connection.db_type} · ${selectedUser.value?.user ?? ""}`,
        plan: plan ? { steps: plan.steps.map((step) => ({ ...step })) } : { steps: [{ id: "oracle-statement", label: t("userAdmin.sqlPreview"), database: "", sql: "", operation: "grantDatabase" as const, subject: selectedUser.value?.user }] },
        displaySql: pendingDisplaySql.value || sql,
        stopRequested: false,
        settled: false,
        retiring: false,
        retiringIdentity: undefined,
        dispatchedStepIds: new Set<string>(),
        rejectedStepIds: new Set<string>(),
        results: [] as AuthorizationStepResult[],
      })
    : undefined;
  if (execution) oracleExecution.value = execution;
  let executionError = false;
  const passwordSecrets = passwordChange ? [newPassword.value, oldPassword.value].filter(Boolean) : [];
  applying.value = true;
  try {
    const result = await executeWithProductionSqlGuard({
      connection,
      database: "",
      sql: pendingDisplaySql.value || sql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        if (!sqlDialogOpen.value || pendingSql.value !== sql || identity !== connectionIdentity.value || selectedUserKey.value !== subjectKey || generation !== previewGeneration || (oracleAction && execution?.stopRequested)) {
          if (oracleAction && execution) {
            execution.stopRequested = true;
            execution.results = execution.plan.steps.map((step) => ({ step, status: "skipped", message: t("oracleSecurity.notSentAfterStop") }));
            return execution.results;
          }
          return undefined;
        }
        if (plan) {
          const capturedPlan = execution?.plan ?? plan;
          const results = await executeAuthorizationPlan(capturedPlan, async (step) => {
            if (oracleAction && execution && (execution.stopRequested || identity !== connectionIdentity.value || selectedUserKey.value !== subjectKey || generation !== previewGeneration)) {
              execution.stopRequested = true;
              throw new Error("ORACLE_EXECUTION_STOPPED_BEFORE_DISPATCH");
            }
            if (oracleAction && execution) execution.dispatchedStepIds.add(step.id);
            let results: Awaited<ReturnType<typeof api.executeMulti>>;
            try {
              results = await api.executeMulti(connection.id, step.database, step.sql, undefined, undefined, { maxRows: 1000, catalog: step.targetCatalog, continueOnError: oracleAction || step.targetCatalog ? false : true });
            } catch (error) {
              if (!oracleAction) throw error;
              return [{ execution_error: true, rows: [[oracleWriteError(String(error))]] } as any];
            }
            if (oracleAction) {
              if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0]?.columns) || !Array.isArray(results[0]?.rows)) return [{ execution_error: true, rows: [[t("oracleSecurity.writeUnknown")]] } as any];
              if (results[0].execution_error) {
                const rawMessage = String(results[0].rows[0]?.[0] ?? "");
                if (execution && oracleWriteRejected(rawMessage, true)) execution.rejectedStepIds.add(step.id);
                return [{ ...results[0], rows: [[oracleWriteError(rawMessage, true)]] }];
              }
            }
            return results;
          });
          if (execution) {
            execution.results = results.map((item) => {
              if (!execution.dispatchedStepIds.has(item.step.id)) return { ...item, status: "skipped", outcome: undefined, message: execution.stopRequested ? t("oracleSecurity.notSentAfterStop") : t("userAdmin.stepSkipped") };
              if (item.status === "failed" && !execution.rejectedStepIds.has(item.step.id)) return { ...item, outcome: "unknown", message: t("oracleSecurity.writeUnknown") };
              return item;
            });
            return execution.results;
          }
          return results;
        }
        let queryResults: Awaited<ReturnType<typeof api.executeMulti>>;
        try {
          if (oracleAction && execution) execution.dispatchedStepIds.add(execution.plan.steps[0].id);
          queryResults = await api.executeMulti(connection.id, "", sql, undefined, undefined, { maxRows: 1000, continueOnError: true });
        } catch (error) {
          if (!oracleAction || !execution) throw error;
          execution.results = [{ step: execution.plan.steps[0], status: "failed", outcome: "unknown", message: t("oracleSecurity.writeUnknown") }];
          return execution.results;
        }
        if (oracleAction && (!Array.isArray(queryResults) || queryResults.length !== 1 || !Array.isArray(queryResults[0]?.columns) || !Array.isArray(queryResults[0]?.rows))) {
          if (execution) execution.results = [{ step: execution.plan.steps[0], status: "failed", outcome: "unknown", message: t("oracleSecurity.writeUnknown") }];
          return execution?.results ?? [];
        }
        const failed = queryResults.find((item) => item.execution_error === true);
        if (failed) {
          if (oracleAction && execution) {
            const rawMessage = String(failed.rows[0]?.[0] ?? "");
            if (oracleWriteRejected(rawMessage, true)) {
              execution.rejectedStepIds.add(execution.plan.steps[0].id);
              execution.results = [{ step: execution.plan.steps[0], status: "failed", message: oracleWriteError(rawMessage, true) }];
            } else {
              execution.results = [{ step: execution.plan.steps[0], status: "failed", outcome: "unknown", message: t("oracleSecurity.writeUnknown") }];
            }
            return execution.results;
          }
          executionError = true;
          throw new Error(String(failed.rows[0]?.[0] ?? t("userAdmin.applyFailedUnknown")));
        }
        if (execution) execution.results = [{ step: execution.plan.steps[0], status: "success" }];
        if (passwordChange?.selfChange) {
          const retiredConfig = { ...connection, password: "", save_password: false };
          const retiredFingerprint = connectionConfigFingerprint(retiredConfig);
          const retiredIdentity = `${connection.id}:${retiredFingerprint}`;
          try {
            if (identity === connectionIdentity.value) {
              const retirementId = ++passwordRetirementId;
              activeRetirementId = retirementId;
              passwordRetirement.value = { id: retirementId, identity, subjectKey, retiredIdentity, retiring: true };
              if (execution) {
                execution.retiring = true;
                execution.retiringIdentity = retiredIdentity;
              }
              const retirement = await connectionStore.retirePasswordAfterChange(passwordChange.connectionId, connectionConfigFingerprint(connection));
              if (execution) execution.retiring = false;
              if (passwordRetirement.value?.id === retirementId) passwordRetirement.value.retiring = false;
              if (
                retirement.status === "retired" &&
                retirement.fingerprint === retiredFingerprint &&
                connectionIdentity.value === `${connection.id}:${retirement.fingerprint}` &&
                selectedUserKey.value === subjectKey &&
                passwordRetirement.value?.id === retirementId &&
                (!execution || oracleExecution.value?.id === execution.id)
              ) {
                passwordReconnectRequired.value = true;
                passwordDialogOpen.value = false;
                toast(t("userAdmin.passwordChangedReconnect"), 8000);
              }
            }
          } catch {
            if (execution) execution.retiring = false;
            if (passwordRetirement.value?.retiredIdentity === connectionIdentity.value && selectedUserKey.value === subjectKey && passwordRetirement.value.id === activeRetirementId && (!execution || oracleExecution.value?.id === execution.id)) {
              passwordReconnectRequired.value = true;
              passwordCleanupFailed.value = true;
              passwordDialogOpen.value = false;
              toast(t("userAdmin.passwordChangedCleanupFailed"), 10000);
            }
          }
        }
        return execution?.results ?? ([] as AuthorizationStepResult[]);
      },
    });
    if (!result) return;
    if (passwordChange?.selfChange) return;
    if (oracleAction && execution) {
      execution.settled = true;
      execution.results = result;
    } else if (identity === connectionIdentity.value && selectedUserKey.value === subjectKey) pendingResults.value = result;
    if (identity !== connectionIdentity.value || selectedUserKey.value !== subjectKey) return;
    const status = result.length > 0 ? authorizationPlanStatus(result) : "success";
    toast(t(status === "success" ? "userAdmin.applySuccess" : status === "partial" ? "userAdmin.applyPartial" : "userAdmin.applyFailedSummary"), status === "success" ? 2500 : 5000);
    const createSucceeded = !plan || result.some((item) => item.step.id === "create-user" && item.status === "success");
    if (createSucceeded && identity === connectionIdentity.value && selectedUserKey.value === subjectKey) await (afterApply?.() ?? Promise.resolve());
    if (!plan && !oracleAction) sqlDialogOpen.value = false;
    await loadUsers();
    await loadGrants();
  } catch (error: any) {
    let message = error?.message || String(error);
    if (oracleAction) {
      message = oracleWriteError(String(message), executionError);
    }
    for (const secret of passwordSecrets) {
      message = message.replaceAll(secret.replaceAll("'", "''"), "***").replaceAll(secret, "***");
    }
    toast(t("userAdmin.applyFailed", { message }), 5000);
  } finally {
    applying.value = false;
    if (execution) execution.settled = true;
    if (passwordRetirement.value?.id === activeRetirementId) passwordRetirement.value = undefined;
  }
}

function oracleWriteError(message: string, executionError = false): string {
  const parsed = parseOracleErrorCode(message);
  const rejected = oracleWriteRejected(message, executionError);
  return `${parsed ? `${parsed.prefix}-${parsed.code} · ` : ""}${t(rejected ? "oracleSecurity.writeRejected" : "oracleSecurity.writeUnknown")}`;
}

function clearPendingSql() {
  if (oracleExecution.value && !oracleExecution.value.settled) {
    requestStopFollowingOracleSteps(oracleExecution.value);
    sqlDialogOpen.value = true;
    return;
  }
  previewGeneration++;
  pendingSql.value = "";
  pendingDisplaySql.value = "";
  pendingPlan.value = undefined;
  pendingResults.value = [];
  pendingAfterApply.value = undefined;
  pendingPasswordChange.value = undefined;
  sqlDialogOpen.value = false;
  if (oracleExecution.value?.settled) oracleExecution.value = undefined;
  newPassword.value = "";
  oldPassword.value = "";
}

function setSqlDialogOpen(open: boolean) {
  if (!open && oracleExecution.value && !oracleExecution.value.settled) {
    requestStopFollowingOracleSteps(oracleExecution.value);
    sqlDialogOpen.value = true;
    return;
  }
  sqlDialogOpen.value = open;
}

function cancelSqlPreview() {
  if (oracleExecution.value && !oracleExecution.value.settled) {
    requestStopFollowingOracleSteps(oracleExecution.value);
    return;
  }
  sqlDialogOpen.value = false;
}

function requestStopFollowingOracleSteps(execution: OracleExecution) {
  if (execution.dispatchedStepIds.size === 0 || execution.dispatchedStepIds.size < execution.plan.steps.length) execution.stopRequested = true;
}

async function reconnectAfterPasswordChange() {
  if (applying.value || passwordCleanupFailed.value) return;
  applying.value = true;
  try {
    await connectionStore.connect(connectionStore.getConfig(props.connection.id) ?? props.connection);
    passwordReconnectRequired.value = false;
    await loadUsers();
    await loadGrants();
  } catch {
    toast(t("userAdmin.passwordChangedReconnect"), 8000);
  } finally {
    applying.value = false;
  }
}

async function previewCreateUser() {
  const userProvider = provider.value;
  if (!userProvider?.createUserSql || preparingCreatePlan.value) return;
  if (!createUser.value.trim() || !createPassword.value || !createDatabaseAuthorizationsValid.value) return;
  const requestId = ++createPlanRequestId;
  const identity = connectionIdentity.value;
  preparingCreatePlan.value = true;
  try {
    const principal = {
      user: createUser.value.trim(),
      host: createHost.value.trim() || "%",
      password: createPassword.value,
      canLogin: createCanLogin.value,
    };
    const databases =
      createAccountType.value === "standard" && userProvider.dialect === "postgres"
        ? await Promise.all(
            createDatabaseAuthorizations.value.map(async (selection) => ({
              ...selection,
              schemas: await api.listSchemas(props.connection.id, selection.database),
            })),
          )
        : createAccountType.value === "standard"
          ? createDatabaseAuthorizations.value
          : [];
    if (requestId !== createPlanRequestId || identity !== connectionIdentity.value || !createDialogOpen.value) return;
    const plan = buildCreateUserAuthorizationPlan({
      provider: userProvider,
      principal,
      accountType: createAccountType.value,
      databases,
    });
    pendingPlan.value = plan;
    pendingSql.value = authorizationPlanSql(plan);
    pendingResults.value = [];
    pendingDanger.value = createAccountType.value === "admin";
    pendingAfterApply.value = async () => {
      createDialogOpen.value = false;
      createPassword.value = "";
      selectedUserKey.value = userKey({ user: principal.user, host: isPostgres.value ? (principal.canLogin ? "LOGIN" : "ROLE") : principal.host });
    };
    sqlDialogOpen.value = true;
  } catch (error: any) {
    if (requestId === createPlanRequestId && identity === connectionIdentity.value) toast(t("userAdmin.prepareAuthorizationFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    if (requestId === createPlanRequestId && identity === connectionIdentity.value) preparingCreatePlan.value = false;
  }
}

function authorizationStepLabel(result: AuthorizationStepResult): string {
  const step = result.step;
  if (step.operation === "createUser") return t("userAdmin.stepCreateUser");
  if (step.operation === "grantAdmin") return t("userAdmin.stepGrantAdmin", { user: step.subject });
  if (step.operation === "grantDatabase") {
    const database = authorizationStepDatabase(step);
    return step.targetTable ? t("userAdmin.stepGrantTable", { user: step.subject, database, table: step.targetTable }) : t("userAdmin.stepGrantDatabase", { user: step.subject, database });
  }
  if (step.operation === "revokePrivileges") {
    const database = authorizationStepDatabase(step);
    return step.targetTable ? t("userAdmin.stepRevokeTable", { user: step.subject, database, table: step.targetTable }) : t("userAdmin.stepRevokeDatabase", { user: step.subject, database });
  }
  if (step.operation === "grantCurrentObjects") {
    if (step.targetTable) return t("userAdmin.stepGrantTable", { user: step.subject, database: authorizationStepDatabase(step), table: step.targetTable });
    return t("userAdmin.stepGrantCurrentObjects", {
      user: step.subject,
      database: step.targetDatabase,
      schema: step.schema,
      scope: authorizationObjectScopeLabel(step.objectScope),
    });
  }
  if (step.operation === "grantFutureObjects") {
    return step.owner
      ? t("userAdmin.stepGrantFutureObjectsForOwner", { user: step.subject, database: step.targetDatabase, owner: step.owner, scope: authorizationObjectScopeLabel(step.objectScope) })
      : t("userAdmin.stepGrantFutureObjects", { user: step.subject, database: step.targetDatabase, scope: authorizationObjectScopeLabel(step.objectScope) });
  }
  return step.label;
}

function authorizationStepDatabase(step: AuthorizationStepResult["step"]): string {
  return [step.targetCatalog, step.targetDatabase, step.targetSchema].filter(Boolean).join(".");
}

function authorizationObjectScopeLabel(scope: AuthorizationStepResult["step"]["objectScope"]): string {
  if (scope === "schemas") return t("userAdmin.scopeSchemas");
  if (scope === "tables") return t("userAdmin.scopeTables");
  if (scope === "sequences") return t("userAdmin.scopeSequences");
  if (scope === "functions") return t("userAdmin.scopeFunctions");
  return "";
}

function previewPasswordChange() {
  const user = selectedUser.value;
  const userProvider = actions.value;
  const alterPasswordSql = userProvider?.alterPasswordSql;
  if (!user || !alterPasswordSql || !newPassword.value) return;
  const prepared = previewGeneratedSql(() => alterPasswordSql(user, newPassword.value, oldPassword.value), {
    danger: true,
    afterApply: async () => {
      passwordDialogOpen.value = false;
      newPassword.value = "";
      oldPassword.value = "";
    },
  });
  if (!prepared) return;
  if (isOracle.value) pendingDisplaySql.value = alterPasswordSql(user, "***", oldPassword.value ? "***" : "");
  pendingPasswordChange.value = { connectionId: props.connection.id, selfChange: isOracle.value ? user.user === oracleSnapshot.value?.currentUser.rows[0] : !!userProvider?.supportsOldPassword && user.user === props.connection.username };
}

function previewHostChange() {
  const user = selectedUser.value;
  const renameUserSql = provider.value?.renameUserSql;
  const host = newHost.value.trim();
  if (!user || !renameUserSql || !host || host === user.host) return;
  previewSql(renameUserSql(user, host), {
    danger: true,
    afterApply: async () => {
      hostDialogOpen.value = false;
      newHost.value = "";
      selectedUserKey.value = userKey({ ...user, host });
    },
  });
}

function previewDropUser() {
  const user = selectedUser.value;
  const userProvider = provider.value;
  const dropUserSql = userProvider?.dropUserSql;
  if (!user || !dropUserSql) return;
  previewSql(dropUserSql(user), { danger: true });
}

function previewLoginChange(enabled: boolean) {
  const user = selectedUser.value;
  const userProvider = actions.value;
  const alterLoginSql = userProvider?.alterLoginSql;
  if (!user || !alterLoginSql) return;
  previewGeneratedSql(() => alterLoginSql(user, enabled), { danger: true });
}

/**
 * 打开授权计划预览：多库/多表会展开为多条 GRANT / REVOKE，
 * 复用既有 SQL 预览弹窗的逐步执行结果与生产环境守卫，无需新增执行链路。
 */
function previewPlan(plan: AuthorizationPlan, options: { danger?: boolean } = {}) {
  if (plan.steps.length === 0) return;
  if (oracleExecution.value?.settled) oracleExecution.value = undefined;
  previewGeneration++;
  pendingDisplaySql.value = "";
  pendingPasswordChange.value = undefined;
  pendingPlan.value = plan;
  pendingSql.value = authorizationPlanSql(plan);
  pendingResults.value = [];
  pendingDanger.value = !!options.danger;
  pendingAfterApply.value = undefined;
  sqlDialogOpen.value = true;
}

async function previewGrant() {
  const user = selectedUser.value;
  const identity = connectionIdentity.value;
  const selectedKey = selectedUserKey.value;
  const userProvider = provider.value;
  const grantPrivilegesSql = actions.value?.grantPrivilegesSql;
  if (!user || !grantPrivilegesSql || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  if (isOracle.value && usePrivilegeScopeEditor.value) {
    if (privilegeAuthorizationsValid.value) previewPlan(buildOracleObjectAuthorizationPlan(actions.value!, user.user, privilegeAuthorizations.value, grantOption.value));
    return;
  }
  if (usePrivilegeScopeEditor.value && userProvider) {
    if (!privilegeAuthorizationsValid.value || !tableGrantDiffReady.value) return;
    const databases = await prepareAuthorizationSelections(privilegeAuthorizations.value);
    if (identity !== connectionIdentity.value || selectedKey !== selectedUserKey.value) return;
    previewPlan(
      buildGrantAuthorizationPlan({
        provider: userProvider,
        user,
        databases,
        grantOption: grantOption.value,
        currentGrants: userProvider.authorizationModel === "mysql" ? undefined : currentTableGrants.value,
      }),
    );
    return;
  }
  previewGeneratedSql(() =>
    grantPrivilegesSql({
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

async function previewRevoke() {
  const user = selectedUser.value;
  const identity = connectionIdentity.value;
  const selectedKey = selectedUserKey.value;
  const userProvider = provider.value;
  const revokePrivilegesSql = actions.value?.revokePrivilegesSql;
  if (!user || !revokePrivilegesSql || (privilegeScope.value === "role" && !privilegeRole.value.trim())) return;
  if (isOracle.value && usePrivilegeScopeEditor.value) {
    if (privilegeAuthorizationsValid.value) previewPlan(buildOracleObjectAuthorizationPlan(actions.value!, user.user, privilegeAuthorizations.value, false, true), { danger: true });
    return;
  }
  if (usePrivilegeScopeEditor.value && userProvider) {
    if (!privilegeAuthorizationsValid.value || !tableGrantDiffReady.value) return;
    const databases = await prepareAuthorizationSelections(privilegeAuthorizations.value);
    if (identity !== connectionIdentity.value || selectedKey !== selectedUserKey.value) return;
    previewPlan(buildGrantAuthorizationPlan({ provider: userProvider, user, databases, revoke: true, currentGrants: userProvider.authorizationModel === "mysql" ? undefined : currentTableGrants.value }), { danger: true });
    return;
  }
  previewGeneratedSql(
    () =>
      revokePrivilegesSql({
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
  if (isOracle.value) {
    selectedPrivileges.value = scope === "system" ? ["CREATE SESSION"] : scope === "table" ? ["SELECT"] : [];
    if (privilegeDatabase.value === "*") privilegeDatabase.value = "";
    if (privilegeTable.value === "*") privilegeTable.value = "";
    grantOption.value = false;
    return;
  }
  const userProvider = provider.value;
  if (!userProvider) return;
  selectedPrivileges.value = userProvider.defaultPrivilegesForScope?.(scope) ?? [];
  if (userProvider.dialect === "postgres") {
    if (scope === "database") privilegeDatabase.value = props.connection.database || "postgres";
    if (scope === "schema" || scope === "table") privilegeDatabase.value = "public";
    if (scope === "table") privilegeTable.value = "*";
  }
}

watch(passwordDialogOpen, (open) => {
  if (open) return;
  newPassword.value = "";
  oldPassword.value = "";
  if (pendingPasswordChange.value) clearPendingSql();
});

watch(sqlDialogOpen, (open) => {
  if (!open) clearPendingSql();
});

watch(
  () => createDialogOpen.value,
  (open) => {
    if (open) return;
    createPlanRequestId += 1;
    preparingCreatePlan.value = false;
  },
);

watch(
  () => selectedUserKey.value,
  () => {
    if (isOracle.value) {
      clearPendingSql();
      passwordDialogOpen.value = false;
      grantOption.value = false;
    }
    tableGrantRequestId += 1;
    grantsLoaded.value = false;
    // 切换用户时清空上一位用户选择的授权范围，避免把权限误授给当前用户
    privilegeAuthorizations.value = [];
    currentTableGrants.value = [];
    currentTableGrantsLoaded.value = false;
    currentTableGrantsLoading.value = false;
    tableGrantLoadError.value = "";
    void loadGrants();
  },
);

watch(
  () => connectionIdentity.value,
  (identity, previousIdentity) => {
    const retirement = passwordRetirement.value;
    const ownPasswordRetirement = !!retirement?.retiring && retirement.identity === previousIdentity && retirement.retiredIdentity === identity;
    usersRequestId++;
    grantsRequestId++;
    databaseRequestId++;
    databaseLoadPromise = undefined;
    createPlanRequestId++;
    previewGeneration++;
    if (oracleExecution.value && !oracleExecution.value.settled) requestStopFollowingOracleSteps(oracleExecution.value);
    oracleSnapshot.value = undefined;
    if (oracleExecution.value && !oracleExecution.value.settled) {
      pendingSql.value = "";
      pendingDisplaySql.value = "";
      pendingPlan.value = undefined;
      pendingResults.value = [];
      pendingAfterApply.value = undefined;
      pendingPasswordChange.value = undefined;
    } else clearPendingSql();
    if (ownPasswordRetirement) {
      oracleSnapshot.value = undefined;
      users.value = [];
      grants.value = [];
      grantsLoaded.value = false;
      loadingGrants.value = false;
      selectedUserKey.value = retirement.subjectKey;
      return;
    }
    passwordDialogOpen.value = false;
    hostDialogOpen.value = false;
    createDialogOpen.value = false;
    passwordReconnectRequired.value = false;
    passwordCleanupFailed.value = false;
    tableGrantRequestId += 1;
    users.value = [];
    createDatabases.value = [];
    createDatabasesLoadError.value = "";
    createDatabaseAuthorizations.value = [];
    privilegeAuthorizations.value = [];
    currentTableGrants.value = [];
    currentTableGrantsLoaded.value = false;
    currentTableGrantsLoading.value = false;
    tableGrantLoadError.value = "";
    selectedUserKey.value = "";
    grants.value = [];
    grantsLoaded.value = false;
    privilegeScope.value = isOracle.value ? "table" : (provider.value?.defaultScope ?? "mysql");
    resetPrivilegeDefaults(privilegeScope.value);
    void loadUsers();
    if (usePrivilegeScopeEditor.value) void preparePrivilegeScopeEditor();
  },
);

let initialProviderSync = true;
watch(
  () => [provider.value, isOracle.value],
  () => {
    if (initialProviderSync) {
      initialProviderSync = false;
      if (restoredUiState.privilegeScope !== undefined) return;
    }
    privilegeScope.value = isOracle.value ? "table" : (provider.value?.defaultScope ?? "mysql");
    resetPrivilegeDefaults(privilegeScope.value);
  },
  { immediate: true },
);

watch(
  () => privilegeScope.value,
  (scope) => {
    resetPrivilegeDefaults(scope);
    syncPrivilegeSelectionFromGrants();
  },
);

watch([privilegeDatabase, privilegeTable], syncPrivilegeSelectionFromGrants);
watch(
  [privilegeDatabase, privilegeTable, privilegeScope, privilegeRole, grantOption, selectedPrivileges, privilegeAuthorizations, newPassword, oldPassword],
  () => {
    if (isOracle.value && sqlDialogOpen.value) clearPendingSql();
  },
  { deep: true, flush: "sync" },
);

watch(
  () => usePrivilegeScopeEditor.value,
  async (enabled) => {
    if (!enabled) return;
    await preparePrivilegeScopeEditor();
  },
);

onMounted(() => {
  void loadUsers();
  if (usePrivilegeScopeEditor.value) void preparePrivilegeScopeEditor();
});
onBeforeUnmount(() => {
  clearPendingSql();
  usersRequestId++;
  grantsRequestId++;
  databaseRequestId++;
});
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
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="passwordReconnectRequired" @click="loadUsers">
          <Loader2 v-if="loadingUsers" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
        <Button v-if="canCreateUser" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="passwordReconnectRequired" @click="openCreateUserDialog">
          <Plus class="h-3.5 w-3.5" />
          {{ t("userAdmin.newUser") }}
        </Button>
      </div>
    </div>

    <div v-if="passwordReconnectRequired" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <p>{{ t(passwordCleanupFailed ? "userAdmin.passwordChangedCleanupFailed" : "userAdmin.passwordChangedReconnect") }}</p>
      <Button v-if="!passwordCleanupFailed" :disabled="applying" @click="reconnectAfterPasswordChange">{{ t("contextMenu.openConnection") }}</Button>
    </div>
    <div v-else-if="!supported" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {{ t("userAdmin.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r bg-muted/10">
        <div class="flex h-12 items-center border-b px-2">
          <div class="flex h-8 items-center gap-2 rounded-md border bg-background px-2">
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input v-model="search" class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t(isOracle ? 'oracleSecurity.filter' : 'userAdmin.searchUser')" />
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
            <Button v-if="canRenameUser" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openHostDialog">
              <Globe2 class="h-3.5 w-3.5" />
              {{ t("userAdmin.changeHost") }}
            </Button>
            <Button v-if="canAlterPassword" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="passwordDialogOpen = true">
              <KeyRound class="h-3.5 w-3.5" />
              {{ t("userAdmin.changePassword") }}
            </Button>
            <Button v-if="canAlterLogin" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(false)">
              <Lock class="h-3.5 w-3.5" />
              {{ loginDisableLabel }}
            </Button>
            <Button v-if="canAlterLogin" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewLoginChange(true)">
              <Unlock class="h-3.5 w-3.5" />
              {{ loginEnableLabel }}
            </Button>
            <Button v-if="canDropUser" variant="destructive" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="previewDropUser">
              <Trash2 class="h-3.5 w-3.5" />
              {{ t("userAdmin.dropUser") }}
            </Button>
          </div>
        </div>

        <div v-if="selectedUser" class="grid min-h-0 flex-1" :class="canEditPrivileges ? 'grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'">
          <section class="flex min-h-0 flex-col" :class="{ 'border-r': canEditPrivileges }">
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
              <OracleSecurityDetails v-else-if="isOracle && oracleSnapshot" :snapshot="oracleSnapshot" :principal="selectedUser.user" />
              <pre v-else class="min-h-full whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground" v-html="highlightedGrantsSql" />
            </div>
          </section>

          <aside v-if="canEditPrivileges" class="flex min-h-0 flex-col bg-muted/10">
            <div class="border-b p-3">
              <div class="text-xs font-semibold">{{ t("userAdmin.privilegeEditor") }}</div>
              <div class="mt-1 text-[11px] leading-4 text-muted-foreground">{{ t(isOracle ? "oracleSecurity.managementHint" : usePrivilegeScopeEditor && provider?.authorizationModel === "mysql" ? "userAdmin.privilegeAppendHint" : "userAdmin.privilegeHint") }}</div>
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3" :class="{ 'flex flex-col': isOracle }">
              <template v-if="isPostgres || isOracle">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.scope") }}</label>
                <Select v-model="privilegeScope">
                  <SelectTrigger class="mb-3 h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem v-if="isOracle" value="system">{{ t("oracleSecurity.system") }}</SelectItem>
                    <SelectItem v-if="!isOracle" value="database">{{ t("userAdmin.scopeDatabase") }}</SelectItem>
                    <SelectItem v-if="!isOracle" value="schema">{{ t("userAdmin.scopeSchema") }}</SelectItem>
                    <SelectItem value="table">{{ t(isOracle ? "oracleSecurity.object" : "userAdmin.scopeTable") }}</SelectItem>
                    <SelectItem value="role">{{ t("userAdmin.scopeRole") }}</SelectItem>
                  </SelectContent>
                </Select>
              </template>

              <template v-if="privilegeScope === 'role'">
                <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.memberRole") }}</label>
                <Input v-model="privilegeRole" class="mb-3 h-8 text-xs" :placeholder="t('userAdmin.memberRole')" />
              </template>
              <div v-else-if="usePrivilegeScopeEditor" class="flex min-h-0 flex-col gap-2" :class="isOracle ? 'flex-1' : 'h-full'">
                <p v-if="isOracle" class="text-[11px] text-muted-foreground">{{ t("oracleSecurity.limited") }}</p>
                <p v-if="createDatabasesLoadError" class="text-[11px] text-destructive">{{ createDatabasesLoadError }}</p>
                <p v-if="isOracle && privilegeAuthorizations.length && !privilegeAuthorizationsValid" class="text-[11px] text-destructive">{{ t("oracleSecurity.invalidObjectSelection") }}</p>
                <AuthorizationScopeEditor :key="connectionIdentity" v-model="privilegeAuthorizations" compact :provider="provider" :object-scope="oracleObjectScope" :databases="createDatabases" :databases-loading="createDatabasesLoading" :connection-id="connection.id" />
                <div v-if="currentTableGrantsLoading" class="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                  {{ t("userAdmin.loadingGrants") }}
                </div>
                <p v-else-if="tableGrantLoadError" class="text-[11px] text-destructive">{{ tableGrantLoadError }}</p>
              </div>
              <template v-else-if="!isOracle">
                <label class="mb-2 block text-xs font-medium">
                  {{ isPostgres && privilegeScope !== "database" ? t("userAdmin.schema") : t("userAdmin.database") }}
                </label>
                <Input v-model="privilegeDatabase" class="mb-3 h-8 text-xs" :placeholder="isPostgres ? 'public' : '*'" />
                <template v-if="!isPostgres || privilegeScope === 'table'">
                  <label class="mb-2 block text-xs font-medium">{{ t("userAdmin.table") }}</label>
                  <Input v-model="privilegeTable" class="mb-3 h-8 text-xs" placeholder="*" />
                </template>
              </template>

              <div v-if="hasPrivilegePicker && !usePrivilegeScopeEditor" class="mb-2 text-xs font-medium">{{ t("userAdmin.privileges") }}</div>
              <div v-if="hasPrivilegePicker && !usePrivilegeScopeEditor" class="grid grid-cols-2 gap-1.5">
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
            </div>
            <label v-if="!isOracle || oracleGrantOptionAllowed" class="flex shrink-0 items-start gap-2 border-t px-3 py-2 text-xs leading-4">
              <input v-model="grantOption" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />
              <span class="min-w-0 flex-1">
                {{ isOracle && privilegeScope !== "table" ? `${t("oracleSecurity.grantOption")} (WITH ADMIN OPTION)` : privilegeScope === "role" ? t("userAdmin.adminOption") : t("userAdmin.grantOption") }}
                <!-- 撤权语句本身不带 GRANT OPTION，明确说明避免误解 -->
                <span v-if="privilegeScope !== 'role'" class="mt-0.5 block text-[10px] text-muted-foreground">{{ t("userAdmin.grantOptionHint") }}</span>
              </span>
            </label>
            <div class="flex shrink-0 items-center justify-end gap-2 border-t p-3">
              <Button v-if="canRevokePrivileges" variant="outline" size="sm" class="h-7 px-2 text-xs" :disabled="usePrivilegeScopeEditor && (!privilegeAuthorizationsValid || !tableGrantDiffReady)" @click="previewRevoke">
                {{ t("userAdmin.revoke") }}
              </Button>
              <Button v-if="canGrantPrivileges" size="sm" class="h-7 px-2 text-xs" :disabled="usePrivilegeScopeEditor && (!privilegeAuthorizationsValid || !tableGrantDiffReady)" @click="previewGrant">
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
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.newUser") }}</DialogTitle>
        </DialogHeader>
        <div class="grid max-h-[70vh] gap-4 overflow-auto pr-1">
          <div class="grid grid-cols-2 gap-2">
            <button type="button" class="rounded-md border p-3 text-left" :class="createAccountType === 'standard' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'" @click="createAccountType = 'standard'">
              <span class="block text-sm font-medium">{{ t("userAdmin.standardUser") }}</span>
              <span class="mt-1 block text-xs text-muted-foreground">{{ t("userAdmin.standardUserHint") }}</span>
            </button>
            <button type="button" class="rounded-md border p-3 text-left" :class="createAccountType === 'admin' ? 'border-destructive bg-destructive/5' : 'hover:bg-muted/40'" @click="createAccountType = 'admin'">
              <span class="block text-sm font-medium">{{ t("userAdmin.adminUser") }}</span>
              <span class="mt-1 block text-xs text-muted-foreground">{{ t("userAdmin.adminUserHint") }}</span>
            </button>
          </div>
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
          <PasswordInput v-model="createPassword" />

          <div v-if="createAccountType === 'admin'" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {{ t("userAdmin.adminUserWarning") }}
          </div>

          <AuthorizationScopeEditor v-else v-model="createDatabaseAuthorizations" :provider="provider" :databases="createDatabases" :databases-loading="createDatabasesLoading" :connection-id="connection.id" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!createUser.trim() || !createPassword || !createDatabaseAuthorizationsValid || preparingCreatePlan" @click="previewCreateUser">
            <Loader2 v-if="preparingCreatePlan" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
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
        <template v-if="actions?.supportsOldPassword">
          <PasswordInput v-model="oldPassword" :placeholder="t('userAdmin.oldPassword')" autocomplete="current-password" />
          <p class="text-xs text-muted-foreground">{{ t("userAdmin.oldPasswordHint") }}</p>
        </template>
        <PasswordInput v-model="newPassword" :placeholder="t('userAdmin.newPassword')" />
        <DialogFooter>
          <Button variant="outline" @click="passwordDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!newPassword" @click="previewPasswordChange">{{ t("userAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="hostDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("userAdmin.changeHost") }}</DialogTitle>
        </DialogHeader>
        <Input v-model="newHost" :placeholder="t('userAdmin.newHost')" />
        <DialogFooter>
          <Button variant="outline" @click="hostDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!canPreviewHostChange" @click="previewHostChange">{{ t("userAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="sqlDialogOpen" @update:open="setSqlDialogOpen">
      <DialogContent class="max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <p v-if="oracleExecution" class="text-xs font-medium text-muted-foreground">{{ oracleExecution.targetLabel }} · {{ oracleExecutionStatus }}</p>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle v-if="pendingDanger" class="h-4 w-4 text-destructive" />
            {{ t("userAdmin.sqlPreview") }}
          </DialogTitle>
          <p v-if="isOracle" class="text-xs text-muted-foreground">{{ t("oracleSecurity.managementHint") }}</p>
        </DialogHeader>
        <div class="grid min-h-0 max-h-full min-w-0 gap-3 overflow-hidden" :class="visibleResults.length > 0 ? 'h-[70vh] grid-rows-[minmax(0,1fr)_minmax(0,1fr)]' : 'h-[50vh] grid-rows-[minmax(0,1fr)]'">
          <pre class="min-h-0 min-w-0 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5" v-html="highlight(oracleVisibleSql)" />
          <div v-if="visibleResults.length > 0" class="grid min-h-0 min-w-0 content-start gap-2 overflow-y-auto overscroll-contain rounded-md border p-3">
            <div class="text-xs font-semibold" :class="visibleStatus === 'success' ? 'text-green-600' : visibleStatus === 'partial' ? 'text-amber-600' : 'text-destructive'">
              {{ t(visibleStatus === "success" ? "userAdmin.resultSuccess" : visibleStatus === "partial" ? "userAdmin.resultPartial" : "userAdmin.resultFailed") }}
            </div>
            <div v-for="result in visibleResults" :key="result.step.id" class="flex items-start gap-2 text-xs">
              <Check v-if="result.status === 'success'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
              <AlertTriangle v-else-if="result.status === 'failed'" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <span v-else class="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground" />
              <span class="min-w-0">
                <span class="block">{{ authorizationStepLabel(result) }}</span>
                <span v-if="result.outcome === 'unknown'" class="mt-0.5 block text-destructive">{{ t("oracleSecurity.writeUnknown") }}</span>
                <span v-else-if="result.message" class="mt-0.5 block break-all text-destructive">{{ result.message }}</span>
                <span v-else-if="result.status === 'skipped'" class="mt-0.5 block text-muted-foreground">{{ result.message || t("userAdmin.stepSkipped") }}</span>
              </span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <template v-if="visibleResults.length === 0">
            <Button variant="outline" :disabled="!!oracleExecution && !oracleExecution.settled && oracleExecution.plan.steps.length === 1 && oracleExecution.dispatchedStepIds.size > 0" @click="cancelSqlPreview">{{
              oracleExecution && !oracleExecution.settled ? (oracleExecution.dispatchedStepIds.size === 0 ? t("oracleSecurity.stopBeforeDispatch") : oracleExecution.plan.steps.length === 1 ? t("common.pending") : t("oracleSecurity.stopFollowing")) : t("dangerDialog.cancel")
            }}</Button>
            <Button v-if="!oracleExecution || oracleExecution.settled" :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying" @click="applyPendingSql">
              <Loader2 v-if="applying" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {{ t("userAdmin.applySql") }}
            </Button>
          </template>
          <Button v-else :disabled="oracleExecution && !oracleExecution.settled" @click="setSqlDialogOpen(false)">{{ t("userAdmin.closeResult") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
