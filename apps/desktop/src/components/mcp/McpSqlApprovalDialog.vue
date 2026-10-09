<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Approval {
  id: string;
  connection_name: string;
  database: string;
  sql: string;
}

const { t } = useI18n();
const pending = ref<Approval[]>([]);
const current = computed(() => pending.value[0]);
const expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unlisten: UnlistenFn | undefined;

onMounted(async () => {
  unlisten = await listen<Approval>("mcp-sql-approval", (event) => {
    if (pending.value.some((approval) => approval.id === event.payload.id)) return;
    pending.value.push(event.payload);
    expirationTimers.set(
      event.payload.id,
      setTimeout(() => {
        pending.value = pending.value.filter((approval) => approval.id !== event.payload.id);
        expirationTimers.delete(event.payload.id);
      }, 90_000),
    );
    void getCurrentWindow().setFocus();
  });
});

onUnmounted(() => {
  unlisten?.();
  for (const timer of expirationTimers.values()) clearTimeout(timer);
  expirationTimers.clear();
});

async function decide(decision: "once" | "hour" | "day" | "deny") {
  const approval = current.value;
  if (!approval) return;
  pending.value.shift();
  clearTimeout(expirationTimers.get(approval.id));
  expirationTimers.delete(approval.id);
  try {
    await invoke("respond_mcp_sql_approval", { id: approval.id, decision });
  } catch (error) {
    console.error("[DBX] MCP SQL approval expired:", error);
  }
}
</script>

<template>
  <Dialog :open="!!current" @update:open="(open) => !open && decide('deny')">
    <DialogContent class="sm:max-w-[640px]">
      <DialogHeader
        ><DialogTitle>{{ t("settings.mcpSqlApprovalTitle") }}</DialogTitle></DialogHeader
      >
      <div v-if="current" class="min-w-0 space-y-3">
        <p class="text-sm">{{ t("settings.mcpSqlApprovalScope", { connection: current.connection_name, database: current.database }) }}</p>
        <pre class="max-h-64 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">{{ current.sql }}</pre>
      </div>
      <DialogFooter class="flex-wrap gap-2">
        <Button variant="outline" @click="decide('deny')">{{ t("settings.mcpSqlApprovalDeny") }}</Button>
        <Button variant="outline" @click="decide('once')">{{ t("settings.mcpSqlApprovalOnce") }}</Button>
        <Button variant="outline" @click="decide('hour')">{{ t("settings.mcpSqlApprovalHour") }}</Button>
        <Button variant="destructive" @click="decide('day')">{{ t("settings.mcpSqlApprovalDay") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
