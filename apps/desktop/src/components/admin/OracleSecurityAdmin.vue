<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import OracleUserAdmin from "@/components/admin/OracleUserAdmin.vue";
import OracleRoleAdmin from "@/components/admin/OracleRoleAdmin.vue";
import { directGrantChange, type OracleRoleChange } from "@/lib/database/oracleRoleAdmin";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig } from "@/types/database";
import { loadOracleSecurity, oracleGrantSources, oracleObjectGrantSources, oracleSecurityObjectMatches, ORACLE_SECURITY_ROW_LIMIT, type OracleSecuritySnapshot } from "@/lib/database/oracleSecurity";

const props = defineProps<{ connection: ConnectionConfig; objectScope?: { owner: string; name: string } }>();
const { t, locale } = useI18n();
const connectionStore = useConnectionStore();
const snapshot = ref<OracleSecuritySnapshot>();
const busy = ref(false);
const error = ref("");
const principal = ref("");
const owner = ref("");
const objectName = ref("");
const search = ref("");
const grantEdit = ref<OracleRoleChange | null>(null);
let generation = 0;
const zh = computed(() => locale.value.startsWith("zh"));
const label = (cn: string, en: string) => zh.value ? cn : en;
const principals = computed(() => snapshot.value ? [...new Set([...snapshot.value.users.rows.map((row) => row.name), ...snapshot.value.roles.rows.map((row) => row.name), "PUBLIC"])].filter((name) => name.includes(search.value)) : []);
const sources = computed(() => snapshot.value ? principal.value ? oracleGrantSources(snapshot.value, principal.value) : { grants: oracleObjectGrantSources(snapshot.value), bounded: false } : { grants: [], bounded: false });
const grants = computed(() => sources.value.grants.filter((row) => !owner.value && !objectName.value || oracleSecurityObjectMatches(row.grant, owner.value, objectName.value)));
const memberships = computed(() => snapshot.value?.roleGrants.rows.filter((row) => !principal.value || row.grantee === principal.value || row.role === principal.value) ?? []);
const sections = computed(() => snapshot.value ? Object.entries(snapshot.value) : []);
const selectedUser = computed(() => snapshot.value?.users.rows.find((row) => row.name === principal.value));
const selectedRole = computed(() => snapshot.value?.roles.rows.find((row) => row.name === principal.value));
const stateLabel = (state: string) => ({ ok: label("已读取", "Loaded"), empty: label("当前范围为空", "Empty in visible scope"), denied: label("无权读取", "Permission denied"), unavailable: label("视图不存在或不可见", "View absent or inaccessible"), error: label("读取失败", "Read failed"), unsupported: label("不支持", "Unsupported") }[state] ?? state);

async function refresh() {
  const request = ++generation;
  const connectionId = props.connection.id;
  busy.value = true;
  error.value = "";
  try {
    await connectionStore.ensureConnected(connectionId);
    const next = await loadOracleSecurity((sql) => api.executeQuery(connectionId, "", sql, undefined, undefined, { maxRows: ORACLE_SECURITY_ROW_LIMIT }));
    if (request !== generation) return;
    snapshot.value = next;
    if (!principal.value && !props.objectScope) principal.value = next.currentUser.rows[0] ?? "";
  } catch (cause) {
    if (request === generation) error.value = String(cause);
  } finally {
    if (request === generation) busy.value = false;
  }
}
watch(() => [props.connection.id, props.objectScope?.owner, props.objectScope?.name], () => { snapshot.value = undefined; principal.value = ""; owner.value = props.objectScope?.owner ?? ""; objectName.value = props.objectScope?.name ?? ""; grantEdit.value = null; void refresh(); }, { immediate: true });
defineExpose({ refresh });
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" data-oracle-security>
    <header class="flex items-center gap-3">
      <h2 class="text-sm font-semibold">{{ objectScope ? label("对象权限", "Object grants") : label("用户、角色与授权", "Users, roles and grants") }}</h2>
      <Button variant="outline" size="sm" :disabled="busy" @click="refresh">{{ busy ? t("grid.loading") : t("grid.refresh") }}</Button>
    </header>
    <p class="text-xs text-muted-foreground">{{ label("显示当前账号可见的授予关系。继承来源不代表角色已在当前会话启用；受限范围无法证明其他授权不存在。", "Shows grants visible to the current account. Role inheritance does not imply that a role is enabled in this session. Limited visibility cannot prove the absence of other grants.") }}</p>
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    <OracleUserAdmin v-if="!objectScope" :connection="connection" :selected-name="selectedUser?.name" @changed="refresh" />
    <div v-if="snapshot" class="grid gap-2 text-xs sm:grid-cols-2">
      <details v-for="[name, result] in sections" :key="name" class="rounded border p-2" :data-security-state="result.state">
        <summary>{{ name }} · {{ stateLabel(result.state) }} · {{ result.rows.length }} · {{ result.visibility === "complete" ? label("完整字典范围", "Full dictionary scope") : label("可见范围受限", "Limited visibility") }}{{ result.truncated ? label("，已达读取上限", ", row limit reached") : "" }}</summary>
        <p v-if="result.message" class="mt-2 whitespace-pre-wrap text-destructive">{{ result.message }}</p>
        <pre class="mt-2 overflow-auto whitespace-pre-wrap">{{ result.source }}</pre>
      </details>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Input v-model="search" class="w-40" :placeholder="label('筛选主体名称', 'Filter principal names')" />
      <select v-model="principal" class="h-9 max-w-72 rounded border bg-background px-2 text-sm" :aria-label="label('主体', 'Principal')">
        <option value="">{{ label("全部可见对象授权", "All visible object grants") }}</option>
        <option v-for="name in principals" :key="name" :value="name">{{ name }}</option>
      </select>
      <Input v-model="owner" :disabled="!!objectScope" class="w-40" :placeholder="label('对象 owner（精确）', 'Exact object owner')" />
      <Input v-model="objectName" :disabled="!!objectScope" class="w-48" :placeholder="label('对象名称（精确）', 'Exact object name')" />
    </div>
    <OracleRoleAdmin :connection="connection" :initial-principal="principal" :initial-owner="owner" :initial-object="objectName" :initial-change="grantEdit" :object-scope="objectScope" @changed="refresh" />
    <p v-if="selectedUser" class="text-xs">{{ selectedUser.name }} · {{ selectedUser.accountStatus || label("账号状态不可见", "Account status unavailable") }} · {{ selectedUser.profile }}</p>
    <p v-if="selectedRole" class="text-xs">{{ label("角色", "Role") }} {{ selectedRole.name }} · PASSWORD_REQUIRED: {{ selectedRole.authentication || label("不可见", "Unavailable") }}</p>
    <p v-if="sources.bounded" role="alert" class="text-xs text-destructive">{{ label("角色关系超过读取边界，以下来源不完整。", "Role traversal reached its limit; the following provenance is incomplete.") }}</p>
    <table class="w-full text-left text-xs">
      <thead><tr class="border-b"><th class="p-2">{{ label("授权类型", "Kind") }}</th><th>{{ label("权限", "Privilege") }}</th><th>{{ label("对象", "Object") }}</th><th>{{ label("来源", "Source") }}</th><th>{{ label("可转授", "Grant option") }}</th><th>{{ label("操作", "Action") }}</th></tr></thead>
      <tbody><tr v-for="(row, index) in grants" :key="index" class="border-b"><td class="p-2">{{ row.kind }}</td><td>{{ row.grant.privilege }}</td><td>{{ 'owner' in row.grant ? `${row.grant.owner}.${row.grant.objectName}` : '—' }}{{ 'columnName' in row.grant ? `.${row.grant.columnName}` : '' }}</td><td>{{ row.source }} · {{ row.grant.grantee }}{{ row.rolePath.length ? ` (${row.rolePath.join(' → ')})` : '' }}{{ 'grantor' in row.grant ? ` · grantor: ${row.grant.grantor}` : '' }}</td><td>{{ 'adminOption' in row.grant ? row.grant.adminOption : row.grant.grantable }}</td><td><Button size="sm" variant="ghost" :disabled="busy || row.kind === 'column' || !(row.source === 'direct' || row.source === 'public' && principal === 'PUBLIC')" :title="label('仅撤销当前主体的直接授权；列级撤销需要独立计划。', 'Only direct grants can be revoked here; column revocation needs a separate plan.')" @click="grantEdit = directGrantChange(row, principal || row.grant.grantee)">{{ label('预览撤销', 'Preview revoke') }}</Button></td></tr></tbody>
    </table>
    <p v-if="snapshot && !grants.length" class="text-xs text-muted-foreground">{{ label("当前可见结果与筛选范围内没有授权记录。", "No grants in the current visible result and filter scope.") }}</p>
    <h3 class="text-sm font-medium">{{ label("角色关系", "Role memberships") }}</h3>
    <table class="w-full text-left text-xs"><thead><tr class="border-b"><th class="p-2">{{ label("主体", "Grantee") }}</th><th>{{ label("角色", "Role") }}</th><th>ADMIN OPTION</th><th>DEFAULT ROLE</th></tr></thead><tbody><tr v-for="(row, index) in memberships" :key="index" class="border-b"><td class="p-2">{{ row.grantee }}</td><td>{{ row.role }}</td><td>{{ row.adminOption }}</td><td>{{ row.defaultRole ?? label('不可见', 'Unavailable') }}</td></tr></tbody></table>
  </section>
</template>
