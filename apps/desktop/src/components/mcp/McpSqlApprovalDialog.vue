<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Desktop confirmation for MCP calls the policy marks "ask first":
 * high-risk SQL (`mcp-sql-approval`, may grant a timed approval) and other
 * high-risk tools such as plugin tools declared `full` or dangerous Redis
 * commands (`mcp-tool-approval`, always one-shot).
 */
interface SqlApproval {
  allow_timed?: boolean;
  id: string;
  connection_name: string;
  database: string;
  sql: string;
}

interface ToolApproval {
  id: string;
  kind: "plugin_tool" | "redis_command" | string;
  tool: string;
  plugin: string | null;
  connection_name: string | null;
  database: string | null;
  detail: string;
}

type Approval = ({ type: "sql" } & SqlApproval) | ({ type: "tool" } & ToolApproval);

const { t } = useI18n();
const pending = ref<Approval[]>([]);
const current = computed(() => pending.value[0]);
const expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const unlisteners: UnlistenFn[] = [];

function enqueue(approval: Approval) {
  if (pending.value.some((item) => item.id === approval.id)) return;
  pending.value.push(approval);
  expirationTimers.set(
    approval.id,
    setTimeout(() => {
      pending.value = pending.value.filter((item) => item.id !== approval.id);
      expirationTimers.delete(approval.id);
    }, 90_000),
  );
  void getCurrentWindow().setFocus();
}

onMounted(async () => {
  unlisteners.push(await listen<SqlApproval>("mcp-sql-approval", (event) => enqueue({ type: "sql", ...event.payload })));
  unlisteners.push(await listen<ToolApproval>("mcp-tool-approval", (event) => enqueue({ type: "tool", ...event.payload })));
});

onUnmounted(() => {
  for (const unlisten of unlisteners) unlisten();
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
    // One response channel for both kinds; tool approvals only accept once/deny.
    await invoke("respond_mcp_sql_approval", { id: approval.id, decision: (approval.type === "tool" || approval.allow_timed === false) && decision !== "deny" ? "once" : decision });
  } catch (error) {
    console.error("[DBX] MCP approval expired:", error);
  }
}

function toolTitle(approval: Extract<Approval, { type: "tool" }>): string {
  if (approval.kind === "redis_command") return t("settings.mcpToolApprovalRedisTitle");
  if (approval.kind === "plugin_tool") return t("settings.mcpToolApprovalPluginTitle", { plugin: approval.plugin ?? approval.tool });
  return t("settings.mcpToolApprovalGenericTitle");
}
</script>

<template>
  <Dialog :open="!!current" @update:open="(open) => !open && decide('deny')">
    <DialogContent class="sm:max-w-[640px]" :data-mcp-approval="current?.type">
      <DialogHeader>
        <DialogTitle>{{ current?.type === "tool" ? toolTitle(current) : t("settings.mcpSqlApprovalTitle") }}</DialogTitle>
      </DialogHeader>
      <div v-if="current?.type === 'sql'" class="min-w-0 space-y-3">
        <p class="text-sm">{{ t("settings.mcpSqlApprovalScope", { connection: current.connection_name, database: current.database }) }}</p>
        <pre class="max-h-64 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">{{ current.sql }}</pre>
      </div>
      <div v-else-if="current?.type === 'tool'" class="min-w-0 space-y-3">
        <p class="text-sm">{{ t("settings.mcpToolApprovalDescription") }}</p>
        <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted-foreground">{{ t("settings.mcpToolApprovalTool") }}</dt>
          <dd class="font-mono">{{ current.tool }}</dd>
          <template v-if="current.connection_name">
            <dt class="text-muted-foreground">{{ t("settings.mcpToolApprovalTarget") }}</dt>
            <dd>{{ current.database ? `${current.connection_name} / ${current.database}` : current.connection_name }}</dd>
          </template>
        </dl>
        <pre class="max-h-64 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all" data-mcp-approval-detail>{{ current.detail }}</pre>
      </div>
      <DialogFooter class="flex-wrap gap-2">
        <Button variant="outline" @click="decide('deny')">{{ t("settings.mcpSqlApprovalDeny") }}</Button>
        <template v-if="current?.type === 'sql' && current.allow_timed !== false">
          <Button variant="outline" @click="decide('once')">{{ t("settings.mcpSqlApprovalOnce") }}</Button>
          <Button variant="outline" @click="decide('hour')">{{ t("settings.mcpSqlApprovalHour") }}</Button>
          <Button variant="destructive" @click="decide('day')">{{ t("settings.mcpSqlApprovalDay") }}</Button>
        </template>
        <Button v-else variant="destructive" data-mcp-approval-allow-once @click="decide('once')">{{ t("settings.mcpSqlApprovalOnce") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
