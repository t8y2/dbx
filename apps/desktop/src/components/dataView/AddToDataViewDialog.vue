<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDataViewStore, type AddQueryInput } from "@/stores/dataViewStore";
import { extractSqlParameters } from "@/lib/sql/sqlParameters";
import { useToast } from "@/composables/useToast";
import type { DataView, DataViewVariable } from "@/types/dataView";

const props = defineProps<{
  open: boolean;
  /** One entry per detected statement block in the source tab (usually a single entry). */
  queries: AddQueryInput[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [view: DataView];
}>();

const { t } = useI18n();
const store = useDataViewStore();
const { toast } = useToast();

type Mode = "create" | "existing";
const mode = ref<Mode>("create");
const viewName = ref("");
const viewDescription = ref("");
const queryTitle = ref("");
const targetViewId = ref<string>("");
const saving = ref(false);

const open = computed({
  get: () => props.open,
  set: (value: boolean) => emit("update:open", value),
});

/** Only the single-query case exposes a title override; multi-query splits keep their own titles. */
const isSingleQuery = computed(() => props.queries.length === 1);

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    await store.ensureLoaded();
    mode.value = store.summaries.length > 0 ? "existing" : "create";
    viewName.value = "";
    viewDescription.value = "";
    queryTitle.value = props.queries[0]?.title || "";
    targetViewId.value = store.sortedSummaries[0]?.id ?? "";
  },
);

/** Seed view variables from every query's `${name}` placeholders (shell syntax). */
function extractedVariables(): DataViewVariable[] {
  const seen = new Set<string>();
  const variables: DataViewVariable[] = [];
  for (const query of props.queries) {
    for (const name of extractSqlParameters(query.sqlTemplate, { enabledSyntaxes: ["shell"] })) {
      if (seen.has(name)) continue;
      seen.add(name);
      variables.push({ name, label: name, kind: "string", inputType: "text", required: true });
    }
  }
  return variables;
}

const canSubmit = computed(() => {
  if (saving.value) return false;
  if (props.queries.length === 0) return false;
  if (mode.value === "create") return viewName.value.trim().length > 0;
  return targetViewId.value.length > 0;
});

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const queries: AddQueryInput[] = isSingleQuery.value ? [{ ...props.queries[0], title: queryTitle.value.trim() || props.queries[0].title }] : props.queries;
    let view: DataView;
    if (mode.value === "create") {
      view = await store.createFromQueries(viewName.value.trim(), viewDescription.value.trim() || undefined, queries);
      // Merge auto-extracted variables that the new queries reference.
      const existing = new Set(view.variables.map((v) => v.name));
      view.variables.push(...extractedVariables().filter((v) => !existing.has(v.name)));
      view = await store.save(view);
    } else {
      view = await store.addQueriesToView(targetViewId.value, queries);
      const existing = new Set(view.variables.map((v) => v.name));
      const added = extractedVariables().filter((v) => !existing.has(v.name));
      if (added.length > 0) {
        view.variables.push(...added);
        view = await store.save(view);
      }
    }
    toast(t("dataView.createdFromQuery"));
    open.value = false;
    emit("saved", view);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("dataView.addToDataView") }}</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <div class="flex gap-2">
          <Button size="sm" :variant="mode === 'create' ? 'secondary' : 'ghost'" @click="mode = 'create'">{{ t("dataView.createNew") }}</Button>
          <Button size="sm" :variant="mode === 'existing' ? 'secondary' : 'ghost'" :disabled="store.summaries.length === 0" @click="mode = 'existing'">{{ t("dataView.addToExisting") }}</Button>
        </div>

        <template v-if="mode === 'create'">
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.name") }}</Label>
          <Input v-model="viewName" :placeholder="t('dataView.name')" />
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.description") }}</Label>
          <Input v-model="viewDescription" :placeholder="t('dataView.description')" />
        </template>

        <template v-else>
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.addToExisting") }}</Label>
          <Select v-model="targetViewId">
            <SelectTrigger><SelectValue :placeholder="t('dataView.title')" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="summary in store.sortedSummaries" :key="summary.id" :value="summary.id">{{ summary.name }}</SelectItem>
            </SelectContent>
          </Select>
        </template>

        <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.queryTitle") }}</Label>
        <Input v-if="isSingleQuery" v-model="queryTitle" :placeholder="t('dataView.queryTitle')" />
        <p v-else class="text-xs text-muted-foreground">{{ t("dataView.multiStatementSplitHint", { count: queries.length }) }}</p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">{{ t("dataView.cancel") }}</Button>
        <Button :disabled="!canSubmit" @click="submit">{{ t("dataView.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
