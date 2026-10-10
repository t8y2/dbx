<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { definitionFromJob, freezeJobChange, jobIdentity, type OracleJobChange, type OracleJobDefinition, type OracleJobIdentity, type OracleJobRow, type OracleJobsResponse, type OracleJobSection } from "@/lib/database/oracleJobs";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; database: string }>();
const { t } = useI18n({
  useScope: "local",
  messages: {
    en: {
      title: "Scheduler jobs",
      refresh: "Refresh",
      create: "New disabled job",
      edit: "Edit disabled job",
      enable: "Preview enable",
      disable: "Preview disable",
      drop: "Preview delete",
      save: "Preview definition",
      owner: "Exact owner",
      name: "Exact job name",
      action: "Job action",
      arguments: "Arguments as a JSON array of strings",
      start: "Start date with offset",
      end: "End date with offset",
      repeat: "Repeat interval",
      preview: "Review job change",
      apply: "Apply reviewed change",
      cancel: "Cancel",
      empty: "No visible rows",
      unknown: "Unknown",
      requestFailed: "The job request failed. Refresh and check database privileges. Action and argument values are omitted from this message.",
      limited: "Current account only",
      legacy: "Legacy DBMS_JOB (read-only)",
      legacyHint: "Legacy numeric job IDs are shown separately. This page does not convert, run or change these jobs.",
      unavailable: "Unavailable",
      unsupported: "This engine/version is not enabled for Scheduler changes.",
      effect: "Creating a job keeps it disabled. Enabling may allow it to run immediately when due. Schedule edits affect future runs. Running jobs follow database rules; no FORCE or STOP is sent. Multi-step changes are not transactional.",
      current: "Current definition and state",
      next: "Current next run",
      scheduleImpact: "Requested schedule impact",
      requestedNext: "Requested next run from engine evaluation",
      evaluationAfter: "Database evaluation time",
      draft: "Requested definition",
      sensitive: "Action and argument values appear only in this explicit editor/review. They are not saved in tab recovery state.",
      sent: "Sent steps",
      completed: "Acknowledged steps",
      verified: "Readback verified",
      partial: "Some steps completed; refresh before recovery",
      failed: "Execution failed; inspect readback",
      unverified: "The requested state was not verified",
      disappeared: "The job disappeared or is no longer visible",
      readback: "Readback",
      before: "Definition before change",
      argumentsInvalid: "Arguments must be a JSON array containing only strings.",
      dates: "Date format: YYYY-MM-DD HH:MM:SS +HH:MM. Empty dates use engine defaults where supported.",
      noSelection: "Select a job to read its definition and history.",
      noDefinition: "This definition cannot be edited because its arguments or supported attributes are unavailable.",
    },
    "zh-CN": {
      title: "调度作业",
      refresh: "刷新",
      create: "新建禁用作业",
      edit: "编辑禁用作业",
      enable: "预览启用",
      disable: "预览禁用",
      drop: "预览删除",
      save: "预览定义",
      owner: "精确 owner",
      name: "精确作业名称",
      action: "作业动作",
      arguments: "参数（字符串 JSON 数组）",
      start: "开始时间（含时区偏移）",
      end: "结束时间（含时区偏移）",
      repeat: "调度表达式",
      preview: "核对作业变更",
      apply: "执行已审阅变更",
      cancel: "取消",
      empty: "无可见记录",
      unknown: "未知",
      requestFailed: "作业请求失败，请刷新并检查数据库权限。此提示不包含动作或参数内容。",
      limited: "仅当前账号",
      legacy: "旧式 DBMS_JOB（只读）",
      legacyHint: "数字作业 ID 单独展示。本页不转换、运行或修改这些作业。",
      unavailable: "不可读取",
      unsupported: "此引擎或版本未开放 Scheduler 写入。",
      effect: "创建的作业保持禁用。启用后到期作业可能立即运行，计划修改影响后续运行。运行中的作业由数据库规则处理，不发送 FORCE 或 STOP。多步变更不是事务。",
      current: "当前定义与状态",
      next: "当前下次运行时间",
      scheduleImpact: "请求计划的运行影响",
      requestedNext: "引擎评估的新计划下次运行",
      evaluationAfter: "数据库评估基准时间",
      draft: "请求的新定义",
      sensitive: "动作和参数只在此编辑及明确预览区展示，不写入标签恢复状态。",
      sent: "已发送步骤",
      completed: "已确认完成步骤",
      verified: "读回已确认",
      partial: "部分步骤完成，请刷新后处理恢复",
      failed: "执行失败，请核对读回结果",
      unverified: "尚未确认达到请求状态",
      disappeared: "作业已消失或已不可见",
      readback: "读回结果",
      before: "变更前定义",
      argumentsInvalid: "参数必须是仅包含字符串的 JSON 数组。",
      dates: "时间格式：YYYY-MM-DD HH:MM:SS +HH:MM。空时间在引擎支持时使用默认值。",
      noSelection: "选择作业以读取定义和运行历史。",
      noDefinition: "参数或支持的属性不可读取，无法编辑此定义。",
    },
  },
});
const connectionStore = useConnectionStore();
const listing = ref<OracleJobsResponse | null>(null);
const details = ref<OracleJobsResponse | null>(null);
const selected = ref<OracleJobIdentity | null>(null);
const selectedLegacy = ref(false);
const editor = ref(false);
const editingAction = ref<"create" | "update">("create");
const owner = ref("");
const name = ref("");
const definition = ref<OracleJobDefinition>({ jobType: "STORED_PROCEDURE", jobAction: "", arguments: [], startDate: "", repeatInterval: "", endDate: "" });
const argumentsText = ref("[]");
const preview = ref<OracleJobsResponse | null>(null);
const change = ref<OracleJobChange | null>(null);
const previewOpen = ref(false);
const outcome = ref<OracleJobsResponse | null>(null);
const busy = ref(false);
const error = ref("");
let epoch = 0;
let alive = true;
const canManage = computed(() => listing.value?.capability?.canManage === true);
const scheduler = computed(() => listing.value?.scheduler);
const legacy = computed(() => (listing.value?.legacy && "rows" in listing.value.legacy ? (listing.value.legacy as OracleJobSection) : undefined));
const identityKey = (row: OracleJobRow) => JSON.stringify([row.OWNER, row.JOB_NAME]);
const display = (value: unknown) => (value == null ? t("unknown") : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));

async function list() {
  if (busy.value) return;
  const request = ++epoch,
    connection = props.connection,
    database = props.database;
  busy.value = true;
  error.value = "";
  try {
    await connectionStore.ensureConnected(connection.id);
    const response = await api.oracleJobs(connection.id, database, { operation: "list" });
    if (alive && request === epoch) listing.value = response;
  } catch {
    if (alive && request === epoch) error.value = t("requestFailed");
  } finally {
    if (alive) {
      busy.value = false;
      if (request !== epoch) void list();
    }
  }
}
async function select(row: OracleJobRow, isLegacy = false) {
  if (busy.value) return;
  const request = ++epoch,
    connection = props.connection,
    database = props.database;
  const identity = jobIdentity(row);
  busy.value = true;
  error.value = "";
  editor.value = false;
  details.value = null;
  outcome.value = null;
  selected.value = identity;
  selectedLegacy.value = isLegacy;
  try {
    const response = await api.oracleJobs(connection.id, database, { operation: isLegacy ? "readLegacy" : "read", identity });
    if (alive && request === epoch) details.value = response;
  } catch {
    if (alive && request === epoch) error.value = t("requestFailed");
  } finally {
    if (alive) {
      busy.value = false;
      if (request !== epoch) void list();
    }
  }
}
function edit(create: boolean) {
  if (!canManage.value || busy.value) return;
  error.value = "";
  try {
    const value = create ? { jobType: "STORED_PROCEDURE", jobAction: "", arguments: [], startDate: "", repeatInterval: "", endDate: "" } : definitionFromJob(details.value ?? {});
    definition.value = value;
    argumentsText.value = JSON.stringify(value.arguments, null, 2);
    owner.value = create ? "" : (selected.value?.owner ?? "");
    name.value = create ? "" : (selected.value?.name ?? "");
    editingAction.value = create ? "create" : "update";
    editor.value = true;
    outcome.value = null;
  } catch {
    error.value = t("noDefinition");
  }
}
async function prepare(action: OracleJobChange["action"]) {
  if (!canManage.value || busy.value) return;
  let requested: OracleJobChange;
  if (action === "create" || action === "update") {
    let args: unknown;
    try {
      args = JSON.parse(argumentsText.value);
    } catch {
      error.value = t("argumentsInvalid");
      return;
    }
    if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
      error.value = t("argumentsInvalid");
      return;
    }
    requested = { action, identity: { owner: owner.value, name: name.value }, definition: { ...definition.value, arguments: args } };
  } else {
    if (!selected.value || selectedLegacy.value) return;
    requested = { action, identity: { ...selected.value } };
  }
  const request = epoch,
    connection = props.connection,
    database = props.database;
  busy.value = true;
  error.value = "";
  try {
    const frozen = freezeJobChange(requested);
    const response = await api.oracleJobs(connection.id, database, { operation: "preview", change: frozen });
    if (!alive || request !== epoch) return;
    change.value = frozen;
    preview.value = response;
    previewOpen.value = true;
  } catch {
    if (alive && request === epoch) error.value = t("requestFailed");
  } finally {
    if (alive) {
      busy.value = false;
      if (request !== epoch) void list();
    }
  }
}
async function apply() {
  if (busy.value || !change.value || !preview.value?.revision) return;
  const request = epoch,
    connection = props.connection,
    database = props.database;
  const requested = freezeJobChange(change.value),
    revision = preview.value.revision;
  busy.value = true;
  error.value = "";
  try {
    const response = await executeWithProductionContextGuard({
      connection,
      database,
      reviewText: preview.value.steps?.map((step) => step.sql).join("\n") ?? "Scheduler change",
      source: t("title"),
      execute: () => (alive && request === epoch ? api.oracleJobs(connection.id, database, { operation: "apply", change: requested, revision }) : Promise.resolve(undefined)),
    });
    if (!alive || request !== epoch) return;
    if (response) {
      outcome.value = response;
      details.value = response.readback ?? null;
      selected.value = response.readback?.job ? { ...requested.identity } : null;
      selectedLegacy.value = false;
      editor.value = false;
    }
    previewOpen.value = false;
  } catch {
    if (alive && request === epoch) error.value = t("requestFailed");
  } finally {
    if (alive) {
      busy.value = false;
      if (request !== epoch) void list();
    }
  }
}
watch(
  () => [props.connection.id, props.database],
  () => {
    ++epoch;
    listing.value = details.value = preview.value = outcome.value = null;
    selected.value = null;
    editor.value = previewOpen.value = false;
    if (!busy.value) void list();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  alive = false;
  ++epoch;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-3 p-3 text-xs">
    <div class="flex items-center gap-2">
      <h2 class="flex-1 font-medium">{{ t("title") }}</h2>
      <Button size="sm" variant="outline" :disabled="busy" @click="list">{{ t("refresh") }}</Button
      ><Button size="sm" :disabled="busy || !canManage" @click="edit(true)">{{ t("create") }}</Button>
    </div>
    <p v-if="listing && !canManage" class="text-muted-foreground">{{ t("unsupported") }} {{ listing.capability?.version }}</p>
    <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
    <div class="grid min-h-0 flex-1 grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)] gap-3">
      <aside class="overflow-auto border-r pr-3">
        <p v-if="scheduler?.availability !== 'available'">{{ t("unavailable") }} · {{ scheduler?.availability }}</p>
        <p v-if="scheduler?.scope === 'current-user-only'">{{ t("limited") }}</p>
        <p v-if="scheduler?.warning">{{ scheduler.warning }}</p>
        <p v-if="scheduler?.availability === 'available' && !scheduler.rows.length">{{ t("empty") }}</p>
        <button v-for="row in scheduler?.rows" :key="identityKey(row)" :disabled="busy" class="block w-full border-b p-2 text-left break-all" @click="select(row)">
          {{ row.OWNER }}.{{ row.JOB_NAME }}<span class="block text-muted-foreground">{{ row.JOB_TYPE }} · {{ display(row.STATE) }} · {{ display(row.ENABLED) }}</span>
        </button>
        <h3 class="mt-4 font-medium">{{ t("legacy") }}</h3>
        <p class="py-2 text-muted-foreground">{{ t("legacyHint") }}</p>
        <p v-if="legacy?.availability !== 'available'">{{ t("unavailable") }} · {{ legacy?.availability }}</p>
        <p v-if="legacy?.scope === 'current-user-only'">{{ t("limited") }}</p>
        <p v-if="legacy?.warning">{{ legacy.warning }}</p>
        <button v-for="row in legacy?.rows" :key="identityKey(row)" :disabled="busy" class="block w-full border-b p-2 text-left" @click="select(row, true)">{{ row.OWNER }} · JOB {{ row.JOB_NAME }} · {{ display(row.BROKEN) }}</button>
      </aside>
      <div class="overflow-auto space-y-3">
        <template v-if="details"
          ><h3>{{ t("current") }}</h3>
          <pre class="whitespace-pre-wrap break-all rounded border p-2">{{ display(details) }}</pre>
          <div v-if="!selectedLegacy && details.job" class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="busy || !canManage" @click="edit(false)">{{ t("edit") }}</Button
            ><Button size="sm" variant="outline" :disabled="busy || !canManage" @click="prepare('enable')">{{ t("enable") }}</Button
            ><Button size="sm" variant="outline" :disabled="busy || !canManage" @click="prepare('disable')">{{ t("disable") }}</Button
            ><Button size="sm" variant="destructive" :disabled="busy || !canManage" @click="prepare('drop')">{{ t("drop") }}</Button>
          </div></template
        >
        <p v-else-if="!editor">{{ t("noSelection") }}</p>
        <div v-if="editor" class="space-y-2 rounded border p-3">
          <p class="text-muted-foreground">{{ t("sensitive") }}</p>
          <div class="flex flex-wrap gap-2">
            <Input v-model="owner" :disabled="busy || editingAction === 'update'" :aria-label="t('owner')" :placeholder="t('owner')" /><Input v-model="name" :disabled="busy || editingAction === 'update'" :aria-label="t('name')" :placeholder="t('name')" /><select
              v-model="definition.jobType"
              :disabled="busy || editingAction === 'update'"
              aria-label="Job type"
              class="rounded border bg-background p-2"
            >
              <option v-for="type in listing?.capability?.jobTypes" :key="type">{{ type }}</option>
            </select>
          </div>
          <label class="block">{{ t("action") }}<textarea v-model="definition.jobAction" :disabled="busy" spellcheck="false" class="min-h-24 w-full rounded border bg-background p-2 font-mono" /></label
          ><label class="block">{{ t("arguments") }}<textarea v-model="argumentsText" :disabled="busy" spellcheck="false" class="min-h-20 w-full rounded border bg-background p-2 font-mono" /></label>
          <p>{{ t("dates") }}</p>
          <Input v-model="definition.startDate" :disabled="busy" :aria-label="t('start')" :placeholder="t('start')" /><Input v-model="definition.repeatInterval" :disabled="busy" :aria-label="t('repeat')" :placeholder="t('repeat')" /><Input
            v-model="definition.endDate"
            :disabled="busy"
            :aria-label="t('end')"
            :placeholder="t('end')"
          /><Button size="sm" :disabled="busy || !owner || !name" @click="prepare(editingAction)">{{ t("save") }}</Button>
        </div>
        <div v-if="outcome" role="status" class="rounded border p-3">
          <p>{{ t(outcome.outcome ?? "unverified") }}</p>
          <p>{{ t("sent") }}: {{ outcome.attemptedSteps?.join(", ") }}</p>
          <p>{{ t("completed") }}: {{ outcome.executedSteps?.join(", ") }}</p>
          <p>{{ outcome.error || outcome.readbackError }}</p>
          <p>{{ outcome.recoveryHint }}</p>
          <details>
            <summary>{{ t("before") }}</summary>
            <pre class="whitespace-pre-wrap break-all">{{ display(preview?.before) }}</pre>
          </details>
          <details>
            <summary>{{ t("readback") }}</summary>
            <pre class="whitespace-pre-wrap break-all">{{ display(outcome.readback) }}</pre>
          </details>
        </div>
      </div>
    </div>
    <Dialog v-model:open="previewOpen"
      ><DialogContent class="max-h-[85vh] overflow-auto"
        ><DialogHeader
          ><DialogTitle>{{ t("preview") }}</DialogTitle></DialogHeader
        >
        <p>{{ change?.identity.owner }}.{{ change?.identity.name }} · {{ change?.action }}</p>
        <p>{{ t("effect") }}</p>
        <p>{{ t("next") }}: {{ display(preview?.before?.job?.NEXT_RUN_DATE) }}</p>
        <section v-if="preview?.scheduleImpact" class="space-y-1 rounded border p-2" data-schedule-impact>
          <h3>{{ t("scheduleImpact") }} · {{ preview.scheduleImpact.state }}</h3>
          <p>{{ t("requestedNext") }}: {{ display(preview.scheduleImpact.requestedNextRun) }}</p>
          <p>{{ t("evaluationAfter") }}: {{ display(preview.scheduleImpact.evaluationAfter) }}</p>
          <p>{{ preview.scheduleImpact.reason }}</p>
        </section>
        <h3>{{ t("draft") }}</h3>
        <pre class="whitespace-pre-wrap break-all">{{ display(change?.definition) }}</pre>
        <details>
          <summary>{{ t("before") }}</summary>
          <pre class="whitespace-pre-wrap break-all">{{ display(preview?.before) }}</pre>
        </details>
        <pre v-for="step in preview?.steps" :key="step.label" class="whitespace-pre-wrap break-all">{{ step.label }} · {{ step.sql }}</pre>
        <DialogFooter
          ><Button variant="outline" :disabled="busy" @click="previewOpen = false">{{ t("cancel") }}</Button
          ><Button :disabled="busy || !preview?.revision" @click="apply">{{ t("apply") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </section>
</template>
