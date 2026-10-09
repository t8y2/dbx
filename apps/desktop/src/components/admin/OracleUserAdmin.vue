<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { userPreviewRequest, validOraclePassword, type OracleUserChange, type OracleUserResponse } from "@/lib/database/oracleUserAdmin";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; selectedName?: string }>();
const emit = defineEmits<{ changed: [] }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const label = (cn: string, en: string) => zh.value ? cn : en;
const name = ref(props.selectedName ?? "");
const action = ref<OracleUserChange["action"]>("alter");
const profile = ref(""); const defaultTablespace = ref(""); const temporaryTablespace = ref(""); const secret = ref("");
const preview = ref<OracleUserResponse | null>(null);
const reviewed = ref<OracleUserChange | null>(null);
const outcome = ref<OracleUserResponse | null>(null);
const previewOpen = ref(false); const busy = ref(false); const error = ref("");
const needsPassword = computed(() => action.value === "create" || action.value === "password");
const attributes = computed(() => action.value === "create" || action.value === "alter");
let epoch = 0; let alive = true;
const errorMessage = () => label("请求失败，请检查权限、目标版本和当前账号状态。凭据未包含在提示中。", "Request failed. Check privileges, target version and account state. Credentials are omitted.");

async function prepare() {
  if (busy.value || !name.value) return;
  error.value = "";
  if (needsPassword.value && !validOraclePassword(secret.value)) { error.value = label("密码不能为空，也不能包含双引号、换行或空字符。", "A password is required and cannot contain a double quote, newline or NUL."); return; }
  const request = userPreviewRequest({ action: action.value, name: name.value, ...(attributes.value ? { profile: profile.value || undefined, defaultTablespace: props.connection.db_type === "oracle" ? defaultTablespace.value || undefined : undefined, temporaryTablespace: props.connection.db_type === "oracle" ? temporaryTablespace.value || undefined : undefined } : {}) });
  const generation = epoch, connection = props.connection;
  busy.value = true;
  try {
    const response = await api.oracleUserAdmin(connection.id, connection.database || "", request);
    if (!alive || generation !== epoch) return;
    reviewed.value = request.change; preview.value = response; previewOpen.value = true;
  } catch { if (alive && generation === epoch) error.value = errorMessage(); }
  finally { if (alive) busy.value = false; }
}
async function apply() {
  if (busy.value || !reviewed.value || !preview.value?.revision || preview.value.blocked) return;
  const generation = epoch, connection = props.connection, change = { ...reviewed.value }, revision = preview.value.revision;
  const credential = preview.value.requiresPassword ? secret.value : undefined;
  busy.value = true; error.value = "";
  try {
    const response = await executeWithProductionContextGuard({ connection, database: connection.database, reviewText: preview.value.steps?.map((step) => step.sql).join("\n") ?? "User change", source: label("用户管理", "User administration"), execute: () => alive && generation === epoch ? api.oracleUserAdmin(connection.id, connection.database || "", { operation: "apply", change, revision, ...(credential !== undefined ? { password: credential } : {}) }) : Promise.resolve(undefined) });
    if (!alive || generation !== epoch) return;
    if (response) { outcome.value = response; emit("changed"); }
    previewOpen.value = false;
  } catch { if (alive && generation === epoch) error.value = errorMessage(); }
  finally { secret.value = ""; if (alive) busy.value = false; }
}
watch(previewOpen, (open) => { if (!open) secret.value = ""; });
watch(action, () => { secret.value = ""; reviewed.value = null; preview.value = null; });
watch(() => props.selectedName, (value) => { ++epoch; name.value = value ?? ""; secret.value = ""; previewOpen.value = false; });
watch(() => [props.connection.id, props.connection.database], () => { ++epoch; secret.value = ""; previewOpen.value = false; preview.value = outcome.value = null; name.value = props.selectedName ?? ""; });
onBeforeUnmount(() => { alive = false; ++epoch; secret.value = ""; });
</script>

<template>
  <details class="rounded border p-3 text-xs" data-oracle-user-admin>
    <summary class="cursor-pointer font-medium">{{ label('用户变更', 'User changes') }}</summary>
    <p class="my-2 text-muted-foreground">{{ label('仅开放 Oracle 19 / OB 4.2.5 已列出的属性。删除前检查对象和依赖，不执行 CASCADE。DDL 不能事务回滚。', 'Uses the listed Oracle 19 / OB 4.2.5 attributes. Deletion checks owned objects and dependencies and never uses CASCADE. DDL cannot be rolled back as a transaction.') }}</p>
    <div class="flex flex-wrap gap-2"><select v-model="action" :disabled="busy" :aria-label="label('用户动作', 'User action')" class="rounded border bg-background p-2"><option value="create">{{ label('创建', 'Create') }}</option><option value="alter">{{ label('修改属性', 'Change attributes') }}</option><option value="password">{{ label('更改密码', 'Change password') }}</option><option value="lock">{{ label('锁定', 'Lock') }}</option><option value="unlock">{{ label('解锁', 'Unlock') }}</option><option value="drop">{{ label('删除', 'Delete') }}</option></select><Input v-model="name" :disabled="busy" class="w-56" :aria-label="label('精确用户名', 'Exact user name')" :placeholder="label('精确用户名', 'Exact user name')" /></div>
    <PasswordInput v-if="needsPassword" v-model="secret" :disabled="busy" class="mt-2 max-w-md" autocomplete="new-password" :aria-label="label('新密码', 'New password')" :placeholder="label('新密码，仅本次执行使用', 'New password, used only for this operation')" />
    <div v-if="attributes" class="mt-2 flex flex-wrap gap-2"><Input v-model="profile" :disabled="busy" class="w-48" placeholder="PROFILE" aria-label="Profile" /><template v-if="connection.db_type === 'oracle'"><Input v-model="defaultTablespace" :disabled="busy" class="w-48" :placeholder="label('默认表空间', 'Default tablespace')" aria-label="Default tablespace" /><Input v-model="temporaryTablespace" :disabled="busy" class="w-48" :placeholder="label('临时表空间', 'Temporary tablespace')" aria-label="Temporary tablespace" /></template></div>
    <Button class="mt-2" size="sm" :disabled="busy || !name" @click="prepare">{{ label('预览用户变更', 'Preview user change') }}</Button><p v-if="error" role="alert" class="my-2 text-destructive">{{ error }}</p>
    <div v-if="outcome" role="status" class="mt-3 rounded border p-2"><p>{{ outcome.outcome }}</p><p>{{ label('已发送 / 已确认步骤', 'Sent / acknowledged steps') }}: {{ outcome.sentSteps?.join(', ') }} / {{ outcome.completedSteps?.join(', ') }}</p><p>{{ outcome.error || outcome.readbackError }}</p><p>{{ label('未自动验证新密码登录，也未改写已保存的连接凭据。', 'New-password login has not been tested and saved connection credentials have not been rewritten.') }}</p><p>{{ outcome.recoveryHint }}</p><details><summary>{{ label('变更前后读回', 'Before and after readback') }}</summary><pre class="whitespace-pre-wrap break-all">{{ JSON.stringify({ before: outcome.before, after: outcome.after }, null, 2) }}</pre></details></div>
    <Dialog v-model:open="previewOpen"><DialogContent class="max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>{{ label('核对用户变更', 'Review user change') }}</DialogTitle></DialogHeader><p>{{ reviewed?.name }} · {{ reviewed?.action }}</p><p v-if="preview?.blocked" role="alert" class="text-destructive">{{ preview.blocked }}</p><pre v-for="step in preview?.steps" :key="step.label" class="whitespace-pre-wrap break-all">{{ step.sql }}</pre><details><summary>{{ label('当前账号、对象及依赖', 'Current account, objects and dependencies') }}</summary><pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(preview?.before, null, 2) }}</pre></details><DialogFooter><Button variant="outline" :disabled="busy" @click="previewOpen = false">{{ label('取消', 'Cancel') }}</Button><Button :disabled="busy || !!preview?.blocked || !preview?.revision" @click="apply">{{ label('执行已审阅变更', 'Apply reviewed change') }}</Button></DialogFooter></DialogContent></Dialog>
  </details>
</template>
