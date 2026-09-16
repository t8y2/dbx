<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CalendarDateTime } from "@internationalized/date";
import { Check, Clock, Eye, Loader2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import DateTimePicker from "@/components/ui/date-time-picker/DateTimePicker.vue";
import { formatLocalDateTime, parseLocalDateTime } from "@/components/ui/date-time-picker/dateTimePicker";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { buildMysqlEventSql } from "@/lib/table/mysqlEventSql";
import type { ConnectionConfig, MysqlEventInfo } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; database: string; schema: string; name?: string; readOnly?: boolean }>();
const emit = defineEmits<{ saved: [name: string]; close: [] }>();
const { t, locale } = useI18n();
const loading = ref(false),
  saving = ref(false),
  error = ref(""),
  preview = ref("");
let loadRequestId = 0;
const activeTab = ref<"definition" | "schedule" | "comment" | "preview">("definition");
const draft = ref<any>({ name: props.name || "", schema: props.schema, schedule: { mode: "every", intervalValue: "1", intervalUnit: "DAY" }, preserve: true, enabled: true, body: "" });
const existing = computed(() => !!props.name);
const units = ["SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"];
const tabs = computed(
  () =>
    [
      { id: "definition", label: t("contextMenu.eventDefinition") },
      { id: "schedule", label: t("contextMenu.eventSchedule") },
      { id: "comment", label: t("contextMenu.eventComment") },
      { id: "preview", label: t("contextMenu.eventSqlPreview") },
    ] as const,
);
const executeAtDate = computed<CalendarDateTime | null>({
  get: () => parseLocalDateTime(draft.value.schedule.executeAt || ""),
  set: (value) => {
    draft.value.schedule.executeAt = value ? formatLocalDateTime(value) : "";
    refreshPreview();
  },
});
const startsDate = computed<CalendarDateTime | null>({
  get: () => parseLocalDateTime(draft.value.starts || ""),
  set: (value) => {
    draft.value.starts = value ? formatLocalDateTime(value) : "";
    refreshPreview();
  },
});
const endsDate = computed<CalendarDateTime | null>({
  get: () => parseLocalDateTime(draft.value.ends || ""),
  set: (value) => {
    draft.value.ends = value ? formatLocalDateTime(value) : "";
    refreshPreview();
  },
});
function refreshPreview() {
  try {
    preview.value = buildMysqlEventSql(draft.value, existing.value ? "ALTER" : "CREATE");
    error.value = "";
  } catch (e) {
    preview.value = "";
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function load() {
  const requestId = ++loadRequestId;
  error.value = "";
  if (!props.name) {
    refreshPreview();
    return;
  }
  loading.value = true;
  try {
    const info: MysqlEventInfo = await api.getEventInfo(props.connection.id, props.database, props.schema, props.name);
    if (requestId !== loadRequestId) return;
    draft.value = {
      name: info.name,
      schema: info.schema,
      schedule: info.execute_at ? { mode: "at", executeAt: info.execute_at } : { mode: "every", intervalValue: info.interval_value || "1", intervalUnit: info.interval_field || "DAY" },
      starts: info.starts || "",
      ends: info.ends || "",
      preserve: info.on_completion?.toUpperCase() === "PRESERVE",
      enabled: info.status?.toUpperCase() === "ENABLED",
      comment: info.comment || "",
      body: info.event_definition || info.event_body || "",
    };
    refreshPreview();
  } catch (e) {
    if (requestId !== loadRequestId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (requestId === loadRequestId) loading.value = false;
  }
}
async function save() {
  if (props.readOnly) return;
  refreshPreview();
  if (!preview.value) return;
  saving.value = true;
  try {
    await executeWithProductionSqlGuard({
      connection: props.connection,
      database: props.database,
      sql: preview.value,
      source: t("contextMenu.eventEditorTitle"),
      execute: async () => {
        await api.executeQuery(props.connection.id, props.database, preview.value, props.schema);
        return true;
      },
    });
    emit("saved", draft.value.name.trim());
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
watch(() => props.name, load);
onMounted(load);
</script>
<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" data-mysql-event-editor>
    <div class="flex items-center justify-between border-b pb-2">
      <div class="flex items-center gap-2 text-sm font-semibold"><Clock class="h-4 w-4 text-orange-400" /> {{ t("contextMenu.eventEditorTitle") }}</div>
      <Button variant="ghost" size="icon" class="h-6 w-6" :aria-label="t('contextMenu.eventCancel')" @click="emit('close')"><X class="h-4 w-4" /></Button>
    </div>
    <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" /> {{ t("contextMenu.eventLoading") }}</div>
    <template v-else>
      <div class="flex gap-1 border-b" role="tablist">
        <button v-for="tab in tabs" :key="tab.id" type="button" class="border-b-2 px-3 py-1.5 text-xs" :class="activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'" @click="activeTab = tab.id">{{ tab.label }}</button>
      </div>
      <div v-if="activeTab === 'definition'" class="flex flex-col gap-3">
        <label class="text-xs">{{ t("contextMenu.eventName") }}<Input v-model="draft.name" :disabled="props.readOnly || existing" class="mt-1 h-8" @input="refreshPreview" /></label
        ><textarea v-model="draft.body" :disabled="props.readOnly" class="min-h-40 rounded border bg-background p-2 font-mono text-xs" :placeholder="t('contextMenu.eventBodyPlaceholder')" @input="refreshPreview" />
      </div>
      <div v-else-if="activeTab === 'schedule'" class="flex flex-col gap-3">
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs"
            >{{ t("contextMenu.eventSchedule")
            }}<select v-model="draft.schedule.mode" :disabled="props.readOnly" class="mt-1 h-8 w-full rounded border bg-background px-2 text-xs" @change="refreshPreview">
              <option value="every">EVERY</option>
              <option value="at">AT</option>
            </select></label
          ><label v-if="draft.schedule.mode === 'every'" class="text-xs"
            >{{ t("contextMenu.eventIntervalUnit")
            }}<select v-model="draft.schedule.intervalUnit" :disabled="props.readOnly" class="mt-1 h-8 w-full rounded border bg-background px-2 text-xs" @change="refreshPreview">
              <option v-for="unit in units" :key="unit" :value="unit">{{ unit }}</option>
            </select></label
          >
        </div>
        <label class="text-xs"
          >{{ draft.schedule.mode === "at" ? t("contextMenu.eventExecuteAt") : t("contextMenu.eventIntervalValue")
          }}<DateTimePicker v-if="draft.schedule.mode === 'at'" v-model="executeAtDate" class="mt-1" :locale="locale" :placeholder="t('dateTimePicker.inputPlaceholder')" :disabled="props.readOnly" full-width /><Input
            v-else
            v-model="draft.schedule.intervalValue"
            :disabled="props.readOnly"
            class="mt-1 h-8"
            placeholder="1"
            @input="refreshPreview"
        /></label>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs">{{ t("contextMenu.eventStarts") }}<DateTimePicker v-model="startsDate" class="mt-1" :locale="locale" :placeholder="t('dateTimePicker.inputPlaceholder')" :disabled="props.readOnly" full-width /></label
          ><label class="text-xs">{{ t("contextMenu.eventEnds") }}<DateTimePicker v-model="endsDate" class="mt-1" :locale="locale" :placeholder="t('dateTimePicker.inputPlaceholder')" :disabled="props.readOnly" full-width /></label>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs"
            >{{ t("contextMenu.eventCompletion")
            }}<select v-model="draft.preserve" :disabled="props.readOnly" class="mt-1 h-8 w-full rounded border bg-background px-2 text-xs" @change="refreshPreview">
              <option :value="true">PRESERVE</option>
              <option :value="false">NOT PRESERVE</option>
            </select></label
          ><label class="text-xs"
            >{{ t("contextMenu.eventStatus")
            }}<select v-model="draft.enabled" :disabled="props.readOnly" class="mt-1 h-8 w-full rounded border bg-background px-2 text-xs" @change="refreshPreview">
              <option :value="true">ENABLE</option>
              <option :value="false">DISABLE</option>
            </select></label
          >
        </div>
      </div>
      <div v-else-if="activeTab === 'comment'">
        <label class="text-xs">{{ t("contextMenu.eventComment") }}<Input v-model="draft.comment" :disabled="props.readOnly" class="mt-1 h-8" :placeholder="t('contextMenu.eventCommentPlaceholder')" @input="refreshPreview" /></label>
      </div>
      <div v-else class="flex min-h-0 flex-1 flex-col gap-2">
        <div class="flex items-center gap-2 text-xs font-medium"><Eye class="h-3.5 w-3.5" /> {{ t("contextMenu.eventSqlPreview") }}</div>
        <pre class="min-h-48 flex-1 overflow-auto rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap">{{ preview }}</pre>
      </div>
      <div v-if="error" class="whitespace-pre-wrap text-xs text-destructive">{{ error }}</div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="emit('close')">{{ t("contextMenu.eventCancel") }}</Button
        ><Button v-if="!props.readOnly" size="sm" :disabled="saving || !preview" @click="save"><Loader2 v-if="saving" class="mr-1 h-3.5 w-3.5 animate-spin" /><Check v-else class="mr-1 h-3.5 w-3.5" />{{ t("contextMenu.eventSave") }}</Button>
      </div>
    </template>
  </div>
</template>
