<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { executeTypeWritePlan, prepareTypeWritePlan, readTypeWriteSnapshot, type TypePart, type TypeSnapshot, type TypeTarget, type TypeWriteIO, type TypeWritePlan, type TypeWriteResult } from "@/lib/database/oracleTypeWrite";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; database: string; initialSchema?: string; initialName?: string }>();
const { t } = useI18n({
  useScope: "local",
  messages: {
    en: {
      title: "Type definitions",
      owner: "Exact owner",
      name: "Exact type name",
      load: "Read current definitions",
      save: "Preview save",
      drop: "Preview drop specification",
      dropBody: "Preview drop body",
      cancel: "Cancel",
      execute: "Execute reviewed steps",
      spec: "TYPE specification",
      body: "TYPE BODY (optional)",
      effect: "DDL is not transactional. The specification is saved before the body. Dropping the specification also removes its body. Dependent objects may become invalid; cancelling cannot undo a sent statement.",
      metadata: "Complete dependency metadata is required. Missing views or permissions prevent a write preview.",
      preview: "Review exact target and SQL",
      references: "Incoming dependencies",
      recovery: "Original definitions and execution record",
      latest: "Latest readback definitions",
      complete: "All steps were read back successfully",
      invalid: "The saved object was not confirmed VALID",
      failed: "Execution or readback failed",
      changed: "Definitions or dependencies changed; read them again",
      cancelled: "Cancelled; inspect sent steps and readback",
      empty: "No existing definition. Enter a full CREATE TYPE definition to create it.",
      sent: "Sent steps",
      original: "Original definition",
      loaded: "Current definitions loaded. An empty editor does not delete an object.",
    },
    "zh-CN": {
      title: "类型定义",
      owner: "精确 owner",
      name: "精确类型名称",
      load: "读取当前定义",
      save: "预览保存",
      drop: "预览删除规格",
      dropBody: "预览删除类型体",
      cancel: "取消",
      execute: "执行已审阅步骤",
      spec: "TYPE 规格",
      body: "TYPE BODY（可选）",
      effect: "DDL 不是事务。先保存规格，再保存类型体。删除规格也会移除类型体。依赖对象可能失效，取消不能撤销已发送的语句。",
      metadata: "写入预览需要完整依赖元数据。视图缺失或权限不足时无法继续。",
      preview: "核对精确目标与 SQL",
      references: "入向依赖",
      recovery: "原定义与执行记录",
      latest: "最新读回定义",
      complete: "所有步骤均已读回确认",
      invalid: "保存后的对象尚未确认 VALID",
      failed: "执行或读回失败",
      changed: "定义或依赖已变化，请重新读取",
      cancelled: "已取消，请核对已发送步骤及读回结果",
      empty: "当前没有定义。输入完整 CREATE TYPE 定义以创建。",
      sent: "已发送步骤",
      original: "原定义",
      loaded: "已读取当前定义。清空编辑框不会删除对象。",
    },
  },
});
const connectionStore = useConnectionStore();
const owner = ref(props.initialSchema ?? "");
const name = ref(props.initialName ?? "");
const specification = ref("");
const body = ref("");
const snapshot = ref<TypeSnapshot | null>(null);
const plan = ref<TypeWritePlan | null>(null);
const outcome = ref<TypeWriteResult | null>(null);
const busy = ref(false);
const error = ref("");
const previewOpen = ref(false);
const ids = new Set<string>();
let epoch = 0;
let alive = true;
let cancelled = false;
const hasSpec = computed(() => snapshot.value?.definitions.some((item) => item.kind === "TYPE"));
const hasBody = computed(() => snapshot.value?.definitions.some((item) => item.kind === "TYPE_BODY"));

function ioFor(target: TypeTarget, connection: ConnectionConfig, database: string, request: number): TypeWriteIO {
  const query = async (sql: string) => {
    const id = `oracle-type-write-${uuid()}`;
    ids.add(id);
    try {
      return await api.executeQuery(connection.id, database, sql, undefined, id, { maxRows: 100000, timeoutSecs: 30 });
    } finally {
      ids.delete(id);
    }
  };
  return { query, execute: query, source: async (kind) => (await api.getObjectSource(connection.id, database, target.schema, target.name, kind)).source, cancelled: () => cancelled || !alive || request !== epoch };
}

function cancel() {
  cancelled = true;
  for (const id of ids) void api.cancelQuery(id).catch(() => undefined);
}
function reset() {
  cancel();
  ++epoch;
  snapshot.value = null;
  plan.value = null;
  outcome.value = null;
  previewOpen.value = false;
  specification.value = body.value = error.value = "";
}

async function load() {
  if (busy.value) return;
  const request = ++epoch;
  const target = { schema: owner.value, name: name.value };
  const connection = props.connection,
    database = props.database;
  busy.value = true;
  error.value = "";
  cancelled = false;
  snapshot.value = null;
  plan.value = null;
  outcome.value = null;
  try {
    await connectionStore.ensureConnected(connection.id);
    const value = await readTypeWriteSnapshot(ioFor(target, connection, database, request), target);
    if (!alive || request !== epoch || cancelled) return;
    snapshot.value = value;
    specification.value = value.definitions.find((item) => item.kind === "TYPE")?.source ?? "";
    body.value = value.definitions.find((item) => item.kind === "TYPE_BODY")?.source ?? "";
  } catch (cause) {
    if (alive && request === epoch) error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    if (alive) busy.value = false;
  }
}

function preview(drop?: TypePart) {
  if (!snapshot.value || busy.value) return;
  error.value = "";
  try {
    plan.value = prepareTypeWritePlan(props.connection.db_type, { schema: owner.value, name: name.value }, snapshot.value, { TYPE: specification.value, TYPE_BODY: body.value }, drop);
    previewOpen.value = true;
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
  }
}

async function execute() {
  if (!plan.value || busy.value) return;
  const current = plan.value;
  const request = epoch;
  const connection = props.connection,
    database = props.database;
  busy.value = true;
  cancelled = false;
  error.value = "";
  try {
    const result = await executeWithProductionContextGuard({ connection, database, reviewText: current.steps.map((step) => step.sql).join("\n/\n"), source: t("title"), execute: () => executeTypeWritePlan(ioFor(current.target, connection, database, request), current) });
    if (!alive || request !== epoch) return;
    if (result) {
      outcome.value = result;
      // A new preview requires an explicit reload; retain the user's draft and recovery record.
      snapshot.value = null;
      plan.value = null;
    }
    previewOpen.value = false;
  } catch (cause) {
    if (alive && request === epoch) error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    if (alive) busy.value = false;
  }
}

watch([owner, name], reset);
watch(
  () => [props.connection.id, props.connection.db_type, props.database, props.initialSchema, props.initialName],
  () => {
    reset();
    owner.value = props.initialSchema ?? "";
    name.value = props.initialName ?? "";
  },
);
onBeforeUnmount(() => {
  alive = false;
  cancel();
  ++epoch;
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-xs">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="font-medium">{{ t("title") }}</h2>
      <Input v-model="owner" :disabled="busy" :aria-label="t('owner')" :placeholder="t('owner')" class="h-8 w-44" /><Input v-model="name" :disabled="busy" :aria-label="t('name')" :placeholder="t('name')" class="h-8 w-44" /><Button
        size="sm"
        variant="outline"
        :disabled="busy || !owner || !name"
        @click="load"
        >{{ t("load") }}</Button
      ><Button v-if="busy" size="sm" variant="ghost" @click="cancel">{{ t("cancel") }}</Button>
    </div>
    <p class="text-muted-foreground">{{ t("metadata") }}</p>
    <p v-if="error" role="alert" class="text-destructive whitespace-pre-wrap">{{ error }}</p>
    <p v-if="snapshot">{{ snapshot.definitions.length ? t("loaded") : t("empty") }}</p>
    <label class="flex min-h-40 flex-1 flex-col gap-1">{{ t("spec") }}<textarea v-model="specification" :disabled="busy || !snapshot" spellcheck="false" class="min-h-36 flex-1 rounded border bg-background p-2 font-mono" /></label>
    <label class="flex min-h-40 flex-1 flex-col gap-1">{{ t("body") }}<textarea v-model="body" :disabled="busy || !snapshot" spellcheck="false" class="min-h-36 flex-1 rounded border bg-background p-2 font-mono" /></label>
    <div class="flex flex-wrap gap-2">
      <Button size="sm" :disabled="busy || !snapshot" @click="preview()">{{ t("save") }}</Button
      ><Button size="sm" variant="outline" :disabled="busy || !hasBody" @click="preview('TYPE_BODY')">{{ t("dropBody") }}</Button
      ><Button size="sm" variant="destructive" :disabled="busy || !hasSpec" @click="preview('TYPE')">{{ t("drop") }}</Button>
    </div>
    <details v-if="snapshot">
      <summary>{{ t("references") }} ({{ snapshot.references.length }})</summary>
      <p v-for="(reference, index) in snapshot.references" :key="index" class="font-mono break-all">{{ reference.owner }}.{{ reference.name }} · {{ reference.kind }} · {{ reference.detail }}</p>
    </details>
    <div v-if="outcome" role="status" class="rounded border p-3">
      <p>{{ t(outcome.state) }}</p>
      <pre v-if="outcome.message" class="whitespace-pre-wrap text-destructive">{{ outcome.message }}</pre>
      <pre v-for="(item, index) in outcome.errors" :key="index" class="whitespace-pre-wrap">{{ item.TYPE }} · {{ item.LINE }}:{{ item.POSITION }} · {{ item.ATTRIBUTE }} · {{ item.TEXT }}</pre>
      <details open>
        <summary>{{ t("recovery") }}</summary>
        <p>{{ t("sent") }}: {{ outcome.sent.length }}</p>
        <pre v-for="(step, index) in outcome.sent" :key="index" class="my-2 whitespace-pre-wrap">{{ index + 1 }} · {{ step.action }} · {{ step.sql }}</pre>
        <div v-for="definition in outcome.before.definitions" :key="definition.kind">
          <p>{{ t("original") }} · {{ definition.kind }}</p>
          <pre class="whitespace-pre-wrap">{{ definition.source }}</pre>
        </div>
      </details>
      <details v-if="outcome.after">
        <summary>{{ t("latest") }}</summary>
        <div v-for="definition in outcome.after.definitions" :key="definition.kind">
          <p>{{ definition.kind }} · {{ definition.status }}</p>
          <pre class="whitespace-pre-wrap">{{ definition.source }}</pre>
        </div>
      </details>
    </div>
    <Dialog v-model:open="previewOpen"
      ><DialogContent class="max-h-[85vh] overflow-auto"
        ><DialogHeader
          ><DialogTitle>{{ t("preview") }}</DialogTitle></DialogHeader
        >
        <p>{{ plan?.target.schema }}.{{ plan?.target.name }}</p>
        <p>{{ t("effect") }}</p>
        <pre v-for="(step, index) in plan?.steps" :key="index" class="whitespace-pre-wrap rounded border p-2"
          >{{ index + 1 }} · {{ step.kind }} · {{ step.action }}
{{ step.sql }}</pre
        >
        <DialogFooter
          ><Button variant="outline" :disabled="busy" @click="previewOpen = false">{{ t("cancel") }}</Button
          ><Button :disabled="busy || !plan" @click="execute">{{ t("execute") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >
  </section>
</template>
