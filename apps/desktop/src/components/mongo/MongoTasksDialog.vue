<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CalendarClock, Plus, RefreshCw, Save, Play, Trash2, Square } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { uuid } from "@/lib/common/utils";
import { parseMongoJson } from "@/lib/mongo/mongoJson";
import { mongoTaskCommand, isActiveMongoTaskRun, parseMongoTaskSteps, type MongoTask, type MongoTaskRun, type MongoTaskSnapshot } from "@/lib/backend/mongoTasks";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t, te } = useI18n();
const endpoint = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const snapshot = ref<MongoTaskSnapshot>({ tasks: [], runs: [], heartbeat: null });
const draft = ref<MongoTask | null>(null);
const stepsText = ref("[]");
const error = ref("");
const busy = ref(false);
const loading = ref(false);
const inspected = ref<MongoTaskRun | null>(null);
const dirty = computed(() => {
  if (!draft.value) return false;
  const saved = snapshot.value.tasks.find((task) => task.id === draft.value?.id);
  return !saved || saved.name !== draft.value.name || saved.enabled !== draft.value.enabled || saved.intervalMinutes !== draft.value.intervalMinutes || stepsText.value !== JSON.stringify(saved.steps, null, 2);
});
const active = (id: string) => snapshot.value.runs.some((run) => run.taskId === id && isActiveMongoTaskRun(run));
let poll: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const backendStatus = computed(() => (snapshot.value.heartbeat ? new Date(snapshot.value.heartbeat).toLocaleString() : t("mongoTasks.noHeartbeat")));

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  const request = generation;
  try {
    const next = await mongoTaskCommand<MongoTaskSnapshot>({ action: "snapshot" });
    if (request !== generation) return;
    snapshot.value = next;
    if (inspected.value) inspected.value = next.runs.find((run) => run.id === inspected.value?.id) ?? inspected.value;
  } catch (cause) {
    if (request === generation) error.value = String(cause);
  } finally {
    loading.value = false;
  }
}
// This timer refreshes status only; scheduling and execution live in Rust/SQLite.
async function refreshStatus() {
  const request = generation;
  await refresh();
  if (open.value && request === generation) poll = setTimeout(refreshStatus, 3000);
}
watch(
  open,
  (visible) => {
    generation++;
    if (poll) clearTimeout(poll);
    if (visible) void refreshStatus();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  if (poll) clearTimeout(poll);
});
function edit(task: MongoTask) {
  if (dirty.value && !window.confirm(t("mongoTasks.discardChanges"))) return;
  draft.value = JSON.parse(JSON.stringify(task)) as MongoTask;
  stepsText.value = JSON.stringify(task.steps, null, 2);
  error.value = "";
}
function create() {
  if (dirty.value && !window.confirm(t("mongoTasks.discardChanges"))) return;
  draft.value = { id: uuid(), name: t("mongoTasks.defaultName"), enabled: false, intervalMinutes: 60, steps: [], revision: "", nextRunAt: null };
  stepsText.value = "[]";
  error.value = "";
}
function addStep(kind: "find" | "aggregate") {
  try {
    const steps = parseMongoJson(stepsText.value);
    if (!Array.isArray(steps)) throw new Error(t("mongoTasks.stepsArray"));
    const query = kind === "find" ? parseMongoJson(endpoint.value.filter || "{}") : [{ $match: {} }];
    steps.push({
      name: `${kind} ${steps.length + 1}`,
      connectionId: endpoint.value.connectionId,
      database: endpoint.value.database,
      collection: endpoint.value.collection,
      kind,
      query,
      maxRows: 100,
      timeoutSeconds: 30,
    });
    stepsText.value = JSON.stringify(steps, null, 2);
  } catch (cause) {
    error.value = String(cause);
  }
}
async function save() {
  if (!draft.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const task = { ...draft.value, steps: parseMongoTaskSteps(stepsText.value) };
    if (task.enabled && !window.confirm(t("mongoTasks.enableConfirm"))) return;
    draft.value = await mongoTaskCommand<MongoTask>({ action: "save", task });
    stepsText.value = JSON.stringify(draft.value.steps, null, 2);
    await refresh();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
async function run(task: MongoTask) {
  if (busy.value || dirty.value) return;
  if (!window.confirm(t("mongoTasks.runConfirm", { name: task.name, count: task.steps.length }))) return;
  busy.value = true;
  error.value = "";
  try {
    inspected.value = await mongoTaskCommand<MongoTaskRun>({ action: "run", id: task.id, revision: task.revision });
    await refresh();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
async function remove(task: MongoTask) {
  if (busy.value || !window.confirm(t("mongoTasks.deleteConfirm", { name: task.name }))) return;
  busy.value = true;
  error.value = "";
  try {
    await mongoTaskCommand({ action: "delete", id: task.id, revision: task.revision });
    draft.value = null;
    await refresh();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
async function cancel(runId: string) {
  try {
    await mongoTaskCommand({ action: "cancel", id: runId });
    await refresh();
  } catch (cause) {
    error.value = String(cause);
  }
}
function status(run: MongoTaskRun) {
  const key = `mongoTasks.statuses.${run.status}`;
  return te(key) ? t(key) : run.status;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(920px,calc(100dvh-2rem))] max-w-[min(1300px,calc(100vw-2rem))] flex-col gap-0 p-0">
      <DialogHeader class="border-b border-border px-5 py-4">
        <DialogTitle class="flex items-center gap-2"><CalendarClock class="size-4" />{{ t("mongoTasks.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">
          {{ t("mongoTasks.subtitle") }}
        </p>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div class="mb-3 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            {{ t("mongoTasks.lifecycleHint") }}
          </p>
          <p class="mt-1">
            {{ t("mongoTasks.readOnlyHint") }}
          </p>
          <p class="mt-1">{{ t("mongoTasks.lastHeartbeat") }}{{ backendStatus }}</p>
        </div>
        <p v-if="error" role="alert" class="mb-3 break-all text-xs text-destructive">{{ error }}</p>
        <div class="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside class="space-y-2">
            <div class="flex gap-2">
              <Button size="sm" :disabled="busy" @click="create"><Plus class="size-3" />{{ t("mongoTasks.new") }}</Button
              ><Button size="sm" variant="outline" :disabled="loading" @click="refresh"><RefreshCw class="size-3" />{{ t("mongoTasks.refresh") }}</Button>
            </div>
            <button v-for="task in snapshot.tasks" :key="task.id" class="w-full rounded-md border border-border p-3 text-left text-xs hover:bg-muted" :class="{ 'bg-muted': draft?.id === task.id }" :disabled="busy" @click="edit(task)">
              <span class="block truncate font-medium">{{ task.name }}</span>
              <span class="text-muted-foreground">{{ task.steps.length }} {{ t("mongoTasks.steps") }} · {{ task.enabled ? t("mongoTasks.scheduled") : t("mongoTasks.manualOnly") }}</span>
              <span v-if="task.nextRunAt" class="mt-1 block text-muted-foreground">{{ t("mongoTasks.nextRun") }}{{ new Date(task.nextRunAt).toLocaleString() }}</span>
            </button>
            <p v-if="!snapshot.tasks.length" class="py-4 text-xs text-muted-foreground">
              {{ t("mongoTasks.empty") }}
            </p>
          </aside>
          <section v-if="draft" class="min-w-0 space-y-3">
            <div class="flex flex-wrap items-end gap-3">
              <label class="flex-1 text-xs">{{ t("mongoTasks.taskName") }}<Input v-model="draft.name" :disabled="busy || active(draft.id)" maxlength="200" class="mt-1 h-8 text-xs" /></label>
              <label class="text-xs">{{ t("mongoTasks.interval") }}<Input v-model.number="draft.intervalMinutes" :disabled="busy || active(draft.id)" type="number" min="1" max="525600" class="mt-1 h-8 w-32 text-xs" /></label>
              <label class="flex h-8 items-center gap-2 text-xs"><input v-model="draft.enabled" :disabled="busy || active(draft.id)" type="checkbox" />{{ t("mongoTasks.enableSchedule") }}</label>
            </div>
            <MongoCompareEndpointSelect v-model="endpoint" :disabled="busy" :label="t('mongoTasks.stepSource')" />
            <div class="flex gap-2">
              <Button size="sm" variant="outline" :disabled="busy || active(draft.id) || !endpoint.collection" @click="addStep('find')">+ find</Button><Button size="sm" variant="outline" :disabled="busy || active(draft.id) || !endpoint.collection" @click="addStep('aggregate')">+ aggregate</Button>
            </div>
            <label class="block text-xs"
              >{{ t("mongoTasks.stepsEditor") }}
              <textarea v-model="stepsText" :disabled="busy || active(draft.id)" spellcheck="false" class="mt-1 min-h-64 w-full rounded-md border border-input bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </label>
            <p class="text-xs text-muted-foreground">
              {{ t("mongoTasks.limitsHint") }}
            </p>
            <div class="flex flex-wrap gap-2">
              <Button size="sm" :disabled="busy || active(draft.id)" @click="save"><Save class="size-3" />{{ t("mongoTasks.save") }}</Button>
              <Button size="sm" variant="outline" :disabled="busy || dirty || active(draft.id) || !draft.revision" @click="run(draft)"><Play class="size-3" />{{ t("mongoTasks.runSaved") }}</Button>
              <Button size="sm" variant="ghost" :disabled="busy || active(draft.id) || !draft.revision" @click="remove(draft)"><Trash2 class="size-3" />{{ t("mongoTasks.delete") }}</Button>
              <span v-if="dirty" class="self-center text-xs text-muted-foreground">{{ t("mongoTasks.unsaved") }}</span>
            </div>
          </section>
          <div v-else class="flex min-h-64 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            {{ t("mongoTasks.selectTask") }}
          </div>
        </div>
        <section class="mt-5 border-t border-border pt-4">
          <h3 class="mb-2 text-sm font-medium">{{ t("mongoTasks.history") }}</h3>
          <div class="max-h-60 overflow-auto rounded-md border border-border">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-muted">
                <tr>
                  <th class="p-2 text-left">{{ t("mongoTasks.taskTime") }}</th>
                  <th class="p-2 text-left">{{ t("mongoTasks.status") }}</th>
                  <th class="p-2 text-right">{{ t("mongoTasks.completedSteps") }}</th>
                  <th class="p-2">{{ t("mongoTasks.actions") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="runItem in snapshot.runs" :key="runItem.id" class="border-t border-border">
                  <td class="p-2">
                    <span class="block">{{ runItem.taskName }}</span
                    ><span class="text-muted-foreground">{{ new Date(runItem.createdAt).toLocaleString() }} · {{ runItem.trigger === "manual" ? t("mongoTasks.manual") : t("mongoTasks.scheduled") }}</span>
                  </td>
                  <td class="p-2" :class="{ 'text-destructive': runItem.status === 'failed' || runItem.status === 'interrupted' }">{{ status(runItem) }}</td>
                  <td class="p-2 text-right">{{ runItem.results.length }}</td>
                  <td class="p-2 text-center">
                    <Button size="sm" variant="ghost" @click="inspected = runItem">{{ t("mongoTasks.details") }}</Button
                    ><Button v-if="isActiveMongoTaskRun(runItem)" size="sm" variant="ghost" @click="cancel(runItem.id)"><Square class="size-3" />{{ t("mongoTasks.cancel") }}</Button>
                  </td>
                </tr>
                <tr v-if="!snapshot.runs.length">
                  <td colspan="4" class="p-5 text-center text-muted-foreground">{{ t("mongoTasks.noRuns") }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="inspected" class="mt-3 rounded-md border border-border p-3">
            <p class="mb-2 text-xs font-medium">{{ inspected.taskName }} · {{ status(inspected) }}</p>
            <p v-if="inspected.error" class="mb-2 break-all text-xs text-destructive">{{ inspected.error }}</p>
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{{ JSON.stringify(inspected.results, null, 2) }}</pre>
          </div>
        </section>
      </div>
      <DialogFooter class="border-t border-border px-4 py-3"
        ><Button variant="outline" @click="open = false">{{ t("mongoTasks.close") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
