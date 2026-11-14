<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { loadOracleTableGrants, ORACLE_SECURITY_ROW_LIMIT, type OracleColumnGrant, type OracleObjectGrant } from "@/lib/database/oracleSecurity";

const props = defineProps<{ target: { connectionId: string; database: string; schema: string; tableName: string; catalog?: string } }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const reads = shallowRef<Awaited<ReturnType<typeof loadOracleTableGrants>> | null>(null);

watch(
  () => props.target,
  async (target, _, onCleanup) => {
    reads.value = null;
    let current = true;
    onCleanup(() => {
      current = false;
    });
    const results = await loadOracleTableGrants((sql) => api.executeQuery(target.connectionId, target.database, sql, undefined, undefined, { catalog: target.catalog, maxRows: ORACLE_SECURITY_ROW_LIMIT }), target.schema, target.tableName);
    if (current) reads.value = results;
  },
  { immediate: true },
);

const groups = computed(() => {
  const byGrantee = new Map<string, Array<OracleObjectGrant | OracleColumnGrant>>();
  for (const read of reads.value ?? []) {
    for (const row of read.rows) {
      const grants = byGrantee.get(row.grantee);
      if (grants) grants.push(row);
      else byGrantee.set(row.grantee, [row]);
    }
  }
  return [...byGrantee.entries()].sort(([left], [right]) => left.localeCompare(right));
});
</script>

<template>
  <Dialog
    :open="true"
    @update:open="
      (open) => {
        if (!open) emit('close');
      }
    "
  >
    <DialogContent class="flex max-h-[min(80vh,640px)] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{{ t("oracleSecurity.tableGrants") }} · {{ target.schema }}.{{ target.tableName }}</DialogTitle>
        <DialogDescription>{{ t("oracleSecurity.sourceNotice") }}</DialogDescription>
      </DialogHeader>
      <div v-if="!reads" class="py-6 text-center text-sm text-muted-foreground" role="status">{{ t("common.loading") }}</div>
      <div v-else class="min-h-0 overflow-auto" data-oracle-table-grants>
        <template v-for="(read, index) in reads" :key="index">
          <p v-if="read.visibility === 'limited'" class="mb-2 text-xs text-muted-foreground" role="status">{{ t(index === 0 ? "oracleSecurity.objectGrants" : "oracleSecurity.columnGrants") }} · {{ t("oracleSecurity.limited") }}{{ read.truncated ? t("oracleSecurity.truncated") : "" }}</p>
          <p v-if="read.message && !['ok', 'empty'].includes(read.state)" class="mb-2 break-words text-xs text-destructive" role="alert">{{ read.message }}</p>
        </template>
        <p v-if="!groups.length" class="py-4 text-sm text-muted-foreground">{{ t("oracleSecurity.noGrants") }}</p>
        <details v-for="[grantee, grants] in groups" :key="grantee" class="border-b py-2" open>
          <summary class="cursor-pointer text-sm font-medium">{{ grantee }}</summary>
          <table class="mt-2 w-full text-left text-xs">
            <thead class="text-muted-foreground">
              <tr>
                <th class="p-1">{{ t("oracleSecurity.privilege") }}</th>
                <th class="p-1">{{ t("oracleSecurity.column") }}</th>
                <th class="p-1">{{ t("oracleSecurity.grantor") }}</th>
                <th class="p-1">{{ t("oracleSecurity.grantOption") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(grant, index) in grants" :key="index">
                <td class="p-1">{{ grant.privilege }}</td>
                <td class="p-1">{{ "columnName" in grant ? grant.columnName : "—" }}</td>
                <td class="p-1">{{ grant.grantor || t("oracleSecurity.unknownGrantor") }}</td>
                <td class="p-1">{{ t(grant.grantable ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </DialogContent>
  </Dialog>
</template>
