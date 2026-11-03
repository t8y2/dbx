<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ShieldAlert } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Desktop confirmation for MCP calls the policy marks "ask first":
 * high-risk SQL (`mcp-sql-approval`, may grant a timed approval) and other
 * high-risk tools such as plugin tools declared `full` or dangerous Redis
 * commands (`mcp-tool-approval`, always one-shot). Every request carries a
 * visible countdown; when it runs out the request is dropped and the caller
 * sees an error. A per-tool "remember" checkbox stores a 24h auto-approve
 * consent so repeated calls to the same tool skip the dialog entirely.
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

type Approval = (({ type: "sql" } & SqlApproval) | ({ type: "tool" } & ToolApproval)) & { deadline?: number };

const APPROVAL_WINDOW_MS = 90_000;
const AUTO_APPROVE_KEY = "dbx.mcp-tool-approval.auto-approve";
const AUTO_APPROVE_TTL_MS = 24 * 60 * 60 * 1000;

interface ToolConsent {
  tool: string;
  until: number;
}

const { t } = useI18n();
const pending = ref<Approval[]>([]);
const current = computed(() => pending.value[0]);
const now = ref(Date.now());
const rememberTool = ref(false);
let ticker: ReturnType<typeof setInterval> | undefined;
const unlisteners: UnlistenFn[] = [];

function loadToolConsents(): ToolConsent[] {
  try {
    const raw = localStorage.getItem(AUTO_APPROVE_KEY);
    return (raw ? (JSON.parse(raw) as ToolConsent[]) : []).filter((item) => typeof item?.tool === "string" && typeof item.until === "number" && item.until > Date.now());
  } catch {
    return [];
  }
}

function toolConsented(tool: string): boolean {
  return loadToolConsents().some((item) => item.tool === tool);
}

function saveToolConsent(tool: string) {
  const consents = loadToolConsents().filter((item) => item.tool !== tool);
  consents.push({ tool, until: Date.now() + AUTO_APPROVE_TTL_MS });
  try {
    localStorage.setItem(AUTO_APPROVE_KEY, JSON.stringify(consents));
  } catch {
    // Persistence is best-effort: without storage the user simply re-approves.
  }
}

function enqueue(approval: Approval) {
  if (pending.value.some((item) => item.id === approval.id)) return;
  // A remembered tool skips the dialog entirely: the stored consent answers
  // this call and the visible queue is not touched.
  if (approval.type === "tool" && toolConsented(approval.tool)) {
    void invoke("respond_mcp_sql_approval", { id: approval.id, decision: "once" }).catch((error) => {
      console.error("[DBX] MCP approval auto-approve failed:", error);
    });
    return;
  }
  approval.deadline = Date.now() + APPROVAL_WINDOW_MS;
  pending.value.push(approval);
  void getCurrentWindow().setFocus();
  startTicker();
}

function startTicker() {
  if (ticker === undefined) {
    ticker = setInterval(() => {
      now.value = Date.now();
      const alive = pending.value.filter((item) => (item.deadline ?? 0) > now.value);
      if (alive.length !== pending.value.length) pending.value = alive;
      if (pending.value.length === 0) stopTicker();
    }, 250);
  }
}

function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

const remainingSeconds = computed(() => {
  if (!current.value) return 0;
  return Math.max(0, Math.ceil(((current.value.deadline ?? 0) - now.value) / 1000));
});

const remainingPercent = computed(() => {
  if (!current.value) return 0;
  return Math.max(0, Math.min(100, Math.round((((current.value.deadline ?? 0) - now.value) / APPROVAL_WINDOW_MS) * 100)));
});

watch(current, () => {
  rememberTool.value = false;
});

onMounted(async () => {
  unlisteners.push(await listen<SqlApproval>("mcp-sql-approval", (event) => enqueue({ type: "sql", ...event.payload })));
  unlisteners.push(await listen<ToolApproval>("mcp-tool-approval", (event) => enqueue({ type: "tool", ...event.payload })));
});

onUnmounted(() => {
  for (const unlisten of unlisteners) unlisten();
  stopTicker();
});

async function decide(decision: "once" | "hour" | "day" | "deny") {
  const approval = current.value;
  if (!approval) return;
  pending.value.shift();
  if (approval.type === "tool" && decision === "once" && rememberTool.value) saveToolConsent(approval.tool);
  rememberTool.value = false;
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
    <!--
      A stray click must never decide a security approval: outside clicks and
      focus moves keep the dialog open, and only the explicit buttons (or Esc /
      the close button, which land here as update:open → deny) resolve it.
    -->
    <DialogContent class="sm:max-w-[640px]" :data-mcp-approval="current?.type" @pointer-down-outside="(event) => event.preventDefault()" @interact-outside="(event) => event.preventDefault()" @focus-outside="(event) => event.preventDefault()">
      <DialogHeader>
        <div class="flex items-center gap-2.5">
          <span class="grid size-8 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400" data-mcp-approval-icon>
            <ShieldAlert class="size-4" />
          </span>
          <DialogTitle>{{ current?.type === "tool" ? toolTitle(current) : t("settings.mcpSqlApprovalTitle") }}</DialogTitle>
        </div>
      </DialogHeader>
      <div v-if="current?.type === 'sql'" class="min-w-0 space-y-3">
        <p class="text-sm">{{ t("settings.mcpSqlApprovalScope", { connection: current.connection_name, database: current.database }) }}</p>
        <pre class="max-h-64 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">{{ current.sql }}</pre>
      </div>
      <div v-else-if="current?.type === 'tool'" class="min-w-0 space-y-3">
        <p class="text-sm">{{ t("settings.mcpToolApprovalDescription") }}</p>
        <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted-foreground">{{ t("settings.mcpToolApprovalTool") }}</dt>
          <dd>
            <span class="rounded bg-muted px-1.5 py-0.5 font-mono" data-mcp-approval-tool>{{ current.tool }}</span>
          </dd>
          <template v-if="current.connection_name">
            <dt class="text-muted-foreground">{{ t("settings.mcpToolApprovalTarget") }}</dt>
            <dd>{{ current.database ? `${current.connection_name} / ${current.database}` : current.connection_name }}</dd>
          </template>
        </dl>
        <div class="space-y-1">
          <p class="text-xs font-medium text-muted-foreground">{{ t("settings.mcpToolApprovalDetail") }}</p>
          <pre class="max-h-64 overflow-auto rounded border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all" data-mcp-approval-detail>{{ current.detail }}</pre>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted-foreground" data-mcp-approval-remember>
          <input v-model="rememberTool" type="checkbox" class="size-3.5 accent-primary" />
          {{ t("settings.mcpToolApprovalAutoApprove") }}
        </label>
      </div>
      <DialogFooter class="flex-col items-stretch gap-3 sm:flex-col">
        <div class="space-y-1.5" data-mcp-approval-countdown>
          <div class="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full transition-[width] duration-300 ease-linear" :class="remainingSeconds <= 10 ? 'bg-red-500' : 'bg-amber-500'" :style="{ width: `${remainingPercent}%` }" data-mcp-approval-remaining-bar />
          </div>
          <p class="text-right text-xs" :class="remainingSeconds <= 10 ? 'font-medium text-red-500' : 'text-muted-foreground'" data-mcp-approval-remaining>
            {{ t("settings.mcpApprovalExpires", { seconds: remainingSeconds }) }}
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" @click="decide('deny')">{{ t("settings.mcpSqlApprovalDeny") }}</Button>
          <template v-if="current?.type === 'sql' && current.allow_timed !== false">
            <Button variant="outline" @click="decide('once')">{{ t("settings.mcpSqlApprovalOnce") }}</Button>
            <Button variant="outline" @click="decide('hour')">{{ t("settings.mcpSqlApprovalHour") }}</Button>
            <Button variant="destructive" @click="decide('day')">{{ t("settings.mcpSqlApprovalDay") }}</Button>
          </template>
          <Button v-else variant="destructive" data-mcp-approval-allow-once @click="decide('once')">{{ t("settings.mcpSqlApprovalOnce") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
