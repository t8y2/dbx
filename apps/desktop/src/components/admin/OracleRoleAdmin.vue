<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { rolePreviewRequest, type OracleRoleChange, type OracleRoleResponse } from "@/lib/database/oracleRoleAdmin";
import { validOraclePassword } from "@/lib/database/oracleUserAdmin";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; initialPrincipal?: string; initialOwner?: string; initialObject?: string; initialChange?: OracleRoleChange | null; objectScope?: { owner: string; name: string } }>();
const emit = defineEmits<{ changed: [] }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const label = (cn: string, en: string) => (zh.value ? cn : en);
const form = ref<OracleRoleChange>({
  action: "grant",
  principal: props.initialPrincipal ?? "",
  kind: props.objectScope ? "object" : "system",
  privilege: props.objectScope ? "SELECT" : "CREATE SESSION",
  owner: props.objectScope?.owner ?? props.initialOwner ?? "",
  objectName: props.objectScope?.name ?? props.initialObject ?? "",
  authentication: "none",
  option: false,
});
const secret = ref("");
const section = ref<HTMLDetailsElement>();
const busy = ref(false);
const error = ref("");
const previewOpen = ref(false);
const preview = ref<OracleRoleResponse | null>(null);
const outcome = ref<OracleRoleResponse | null>(null);
const reviewed = ref<OracleRoleChange | null>(null);
let epoch = 0;
let alive = true;
const lifecycle = computed(() => ["createRole", "alterRole", "dropRole"].includes(form.value.action));
const needsPassword = computed(() => ["createRole", "alterRole"].includes(form.value.action) && form.value.authentication === "password");
const errorMessage = () => label("请求失败。请检查目标版本、字典权限和当前授权状态；凭据不包含在提示中。", "Request failed. Check version, dictionary permissions and current grants; credentials are omitted.");

async function prepare() {
  if (busy.value || !form.value.principal) return;
  if (props.objectScope && !["grant", "revoke"].includes(form.value.action)) return;
  if (needsPassword.value && !validOraclePassword(secret.value)) {
    error.value = label("密码不能为空，也不能包含双引号、换行或空字符。", "A password is required and cannot contain a double quote, newline or NUL.");
    return;
  }
  const request = rolePreviewRequest(props.objectScope ? { ...form.value, kind: "object", owner: props.objectScope.owner, objectName: props.objectScope.name } : form.value),
    generation = epoch,
    connection = props.connection;
  busy.value = true;
  error.value = "";
  try {
    const response = await api.oracleRoleAdmin(connection.id, connection.database || "", request);
    if (!alive || generation !== epoch) return;
    reviewed.value = request.change;
    preview.value = response;
    previewOpen.value = true;
  } catch {
    if (alive && generation === epoch) error.value = errorMessage();
  } finally {
    if (alive) busy.value = false;
  }
}
async function apply() {
  if (busy.value || !reviewed.value || !preview.value?.revision || preview.value.blocked) return;
  const generation = epoch,
    connection = props.connection,
    change = { ...reviewed.value },
    revision = preview.value.revision;
  const credential = preview.value.requiresPassword ? secret.value : undefined;
  busy.value = true;
  error.value = "";
  try {
    const response = await executeWithProductionContextGuard({
      connection,
      database: connection.database,
      reviewText: preview.value.steps?.map((step) => step.sql).join("\n") ?? "Role change",
      source: label("角色与授权", "Roles and grants"),
      execute: () => (alive && generation === epoch ? api.oracleRoleAdmin(connection.id, connection.database || "", { operation: "apply", change, revision, ...(credential !== undefined ? { password: credential } : {}) }) : Promise.resolve(undefined)),
    });
    if (!alive || generation !== epoch) return;
    if (response) {
      outcome.value = response;
      emit("changed");
    }
    previewOpen.value = false;
  } catch {
    if (alive && generation === epoch) error.value = errorMessage();
  } finally {
    secret.value = "";
    if (alive) busy.value = false;
  }
}
watch(previewOpen, (open) => {
  if (!open) secret.value = "";
});
watch(
  () => form.value.action,
  () => {
    secret.value = "";
    preview.value = null;
  },
);
watch(
  () => props.initialChange,
  async (change) => {
    if (!change) return;
    ++epoch;
    secret.value = "";
    previewOpen.value = false;
    form.value = { ...change };
    await nextTick();
    if (section.value) section.value.open = true;
  },
  { immediate: true },
);
watch(
  () => [props.initialPrincipal, props.initialOwner, props.initialObject],
  () => {
    ++epoch;
    secret.value = "";
    previewOpen.value = false;
    form.value.principal = props.initialPrincipal ?? "";
    form.value.owner = props.initialOwner ?? "";
    form.value.objectName = props.initialObject ?? "";
  },
);
watch(
  () => [props.connection.id, props.connection.database],
  () => {
    ++epoch;
    secret.value = "";
    previewOpen.value = false;
    preview.value = outcome.value = null;
  },
);
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
  secret.value = "";
});
</script>

<template>
  <details ref="section" class="rounded border p-3 text-xs" data-oracle-role-admin @toggle="!section?.open && (secret = '')">
    <summary class="cursor-pointer font-medium">{{ label("角色和授权变更", "Role and grant changes") }}</summary>
    <p class="my-2 text-muted-foreground">
      {{
        label(
          "基于最新完整字典预览。只撤销精确匹配的直接授权；继承或 PUBLIC 权限可能仍然存在。角色来源不代表当前会话已启用。对象撤销可能级联影响下游授权，角色删除会移除其成员关系。",
          "Preview uses fresh complete dictionary data. Only an exact direct grant is revoked; role or PUBLIC access may remain. Provenance does not imply enabled session roles. Object revocation may cascade to downstream grants; dropping a role removes memberships.",
        )
      }}
    </p>
    <div class="flex flex-wrap gap-2">
      <select v-model="form.action" :disabled="busy" aria-label="Role action" class="rounded border bg-background p-2">
        <option value="grant">{{ label("授予", "Grant") }}</option>
        <option value="revoke">{{ label("撤销", "Revoke") }}</option>
        <option v-if="!objectScope" value="createRole">{{ label("创建角色", "Create role") }}</option>
        <option v-if="!objectScope" value="alterRole">{{ label("修改角色认证", "Change role authentication") }}</option>
        <option v-if="!objectScope" value="dropRole">{{ label("删除角色", "Drop role") }}</option></select
      ><Input v-model="form.principal" :disabled="busy" class="w-56" :placeholder="lifecycle ? label('精确角色名称', 'Exact role name') : label('精确主体名称', 'Exact principal')" aria-label="Principal" />
    </div>
    <template v-if="lifecycle"
      ><div v-if="form.action !== 'dropRole'" class="mt-2 flex flex-wrap gap-2">
        <select v-model="form.authentication" :disabled="busy" aria-label="Role authentication" class="rounded border bg-background p-2">
          <option value="none">NOT IDENTIFIED</option>
          <option value="password">IDENTIFIED BY</option></select
        ><PasswordInput v-if="needsPassword" v-model="secret" :disabled="busy" autocomplete="new-password" :placeholder="label('角色密码，仅本次执行使用', 'Role password, used only for this operation')" aria-label="Role password" /></div
    ></template>
    <div v-else class="mt-2 space-y-2">
      <select v-model="form.kind" :disabled="busy || !!objectScope" aria-label="Grant kind" class="rounded border bg-background p-2" @change="form.privilege = form.kind === 'object' ? 'SELECT' : 'CREATE SESSION'">
        <option value="system">{{ label("系统权限", "System privilege") }}</option>
        <option value="object">{{ label("对象权限", "Object privilege") }}</option>
        <option value="role">{{ label("角色成员关系", "Role membership") }}</option></select
      ><Input v-if="form.kind === 'role'" v-model="form.role" :disabled="busy" class="max-w-md" :placeholder="label('要授予或撤销的精确角色', 'Exact role to grant or revoke')" aria-label="Granted role" /><Input
        v-else
        v-model="form.privilege"
        :disabled="busy"
        class="max-w-md"
        placeholder="CREATE SESSION / SELECT / EXECUTE"
        aria-label="Privilege"
      />
      <div v-if="form.kind === 'object'" class="flex flex-wrap gap-2">
        <Input v-model="form.owner" :disabled="busy || !!objectScope" class="w-48" placeholder="Owner" aria-label="Object owner" /><Input
          v-model="form.objectName"
          :disabled="busy || !!objectScope"
          class="w-48"
          :placeholder="label('精确对象名称', 'Exact object name')"
          aria-label="Object name"
        /><Input v-model="form.column" :disabled="busy" class="w-48" :placeholder="label('列（可选）', 'Column (optional)')" aria-label="Column" /><Input
          v-if="form.action === 'revoke'"
          v-model="form.grantor"
          :disabled="busy"
          class="w-48"
          :placeholder="label('原始直接 grantor', 'Exact direct grantor')"
          aria-label="Grantor"
        />
      </div>
      <label v-if="form.action === 'grant'" class="flex items-center gap-2"><input v-model="form.option" type="checkbox" :disabled="busy" />{{ form.kind === "object" ? "WITH GRANT OPTION" : "WITH ADMIN OPTION" }}</label>
    </div>
    <Button class="mt-2" size="sm" :disabled="busy || !form.principal" @click="prepare">{{ label("预览角色或授权变更", "Preview role or grant change") }}</Button>
    <p v-if="error" role="alert" class="my-2 text-destructive">{{ error }}</p>
    <div v-if="outcome" role="status" class="mt-3 rounded border p-2">
      <p>{{ outcome.outcome }}</p>
      <p>{{ label("已发送 / 已确认步骤", "Sent / acknowledged steps") }}: {{ outcome.sentSteps?.join(", ") }} / {{ outcome.completedSteps?.join(", ") }}</p>
      <p>{{ outcome.error || outcome.readbackError }}</p>
      <p>{{ outcome.recoveryHint }}</p>
      <p>{{ label("未自动执行 SET ROLE 验证新密码激活角色。", "Role activation with the new password has not been tested with SET ROLE.") }}</p>
      <details open>
        <summary>{{ label("剩余直接、角色或 PUBLIC 来源", "Remaining direct, role or PUBLIC sources") }}</summary>
        <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(outcome.remainingSources, null, 2) }}</pre>
      </details>
      <details>
        <summary>{{ label("变更前后字典", "Before and after dictionary") }}</summary>
        <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify({ before: outcome.before, after: outcome.after }, null, 2) }}</pre>
      </details>
    </div>
    <Dialog v-model:open="previewOpen"
      ><DialogContent class="max-h-[85vh] overflow-auto"
        ><DialogHeader
          ><DialogTitle>{{ label("核对角色与授权变更", "Review role and grant change") }}</DialogTitle></DialogHeader
        >
        <p>{{ reviewed?.principal }} · {{ reviewed?.action }}</p>
        <p v-if="preview?.blocked" role="alert" class="text-destructive">{{ preview.blocked }}</p>
        <p>{{ preview?.impact }}</p>
        <pre v-for="step in preview?.steps" :key="step.label" class="whitespace-pre-wrap break-all">{{ step.sql }}</pre>
        <details open>
          <summary>{{ label("当前匹配的授权来源", "Current matching grant sources") }}</summary>
          <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(preview?.sources, null, 2) }}</pre>
        </details>
        <details>
          <summary>{{ label("成员、对象依赖及完整字典", "Memberships, object dependencies and full dictionary") }}</summary>
          <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(preview?.before, null, 2) }}</pre>
        </details>
        <DialogFooter
          ><Button variant="outline" :disabled="busy" @click="previewOpen = false">{{ label("取消", "Cancel") }}</Button
          ><Button :disabled="busy || !!preview?.blocked || !preview?.revision" @click="apply">{{ label("执行已审阅变更", "Apply reviewed change") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </details>
</template>
