<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertTriangle, Loader2, RefreshCcw, Server } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import type { ConsulAgentIdentity, ConsulAgentMember, ConsulCapabilities, ConsulOperatorDocument } from "@/types/consul";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const capabilities = ref<ConsulCapabilities | null>(null);
const identity = ref<ConsulAgentIdentity | null>(null);
const leader = ref<string | null>(null);
const peers = ref<string[]>([]);
const members = ref<ConsulAgentMember[]>([]);
const autopilotHealth = ref<ConsulOperatorDocument | null>(null);
const errors = ref<Record<string, string>>({});
const loading = ref(false);
let sequence = 0;
type ProbeState = "loading" | "ready" | "forbidden" | "unsupported" | "error";
const probeKeys = ["capabilities", "agent", "leader", "peers", "members", "autopilot"] as const;
type ProbeKey = (typeof probeKeys)[number];
const probeStates = ref<Record<ProbeKey, ProbeState>>({ capabilities: "loading", agent: "loading", leader: "loading", peers: "loading", members: "loading", autopilot: "loading" });

const memberSummary = computed(() => {
  const alive = members.value.filter((member) => member.Status === 1).length;
  return `${alive}/${members.value.length}`;
});

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function classifyProbeError(error: unknown): ProbeState {
  const detail = message(error).toLowerCase();
  if (detail.includes("consul_permission_denied") || detail.includes("forbidden") || detail.includes("403")) return "forbidden";
  if (detail.includes("unsupported") || detail.includes("not found") || detail.includes("404")) return "unsupported";
  return "error";
}

function probeLabel(key: ProbeKey) {
  return key === "capabilities" ? t("consul.ui.capabilities") : key === "agent" ? t("consul.ui.agent") : key === "leader" ? t("consul.ui.leader") : key === "peers" ? t("consul.ui.raftPeers") : key === "members" ? t("consul.ui.members") : t("consul.ui.autopilotHealth");
}

function probeStateLabel(state: ProbeState) {
  return t(`consul.ui.probe${state[0].toUpperCase()}${state.slice(1)}`);
}

async function load() {
  const current = ++sequence;
  loading.value = true;
  errors.value = {};
  probeStates.value = { capabilities: "loading", agent: "loading", leader: "loading", peers: "loading", members: "loading", autopilot: "loading" };
  const tasks = [
    ["capabilities", api.consulCapabilities(props.connectionId), (value: ConsulCapabilities) => (capabilities.value = value)],
    ["agent", api.consulAgentSelf(props.connectionId), (value: ConsulAgentIdentity) => (identity.value = value)],
    ["leader", api.consulStatusLeader(props.connectionId), (value: string) => (leader.value = value)],
    ["peers", api.consulStatusPeers(props.connectionId), (value: string[]) => (peers.value = value)],
    ["members", api.consulAgentMembers(props.connectionId), (value: ConsulAgentMember[]) => (members.value = value)],
    ["autopilot", api.consulOperatorRead(props.connectionId, "autopilot_health"), (value: ConsulOperatorDocument) => (autopilotHealth.value = value)],
  ] as const;
  await Promise.all(
    tasks.map(async ([name, promise, assign]) => {
      try {
        const value = await promise;
        if (current === sequence) {
          (assign as (value: never) => void)(value as never);
          probeStates.value = { ...probeStates.value, [name]: "ready" };
        }
      } catch (error) {
        if (current === sequence) {
          errors.value = { ...errors.value, [name]: message(error) };
          probeStates.value = { ...probeStates.value, [name]: classifyProbeError(error) };
        }
      }
    }),
  );
  if (current === sequence) loading.value = false;
}

watch(() => props.connectionId, load);
onMounted(load);
defineExpose({ refresh: () => (void load(), true) });
</script>

<template>
  <div class="h-full overflow-auto p-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-sm font-medium"><Server class="h-4 w-4" /> {{ t("consul.ui.overview") }}</h2>
      <Button size="icon" variant="ghost" class="h-7 w-7" :disabled="loading" :title="t('consul.ui.refresh')" @click="load"> <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" /><RefreshCcw v-else class="h-3.5 w-3.5" /> </Button>
    </div>
    <div class="grid border-l border-t sm:grid-cols-2 lg:grid-cols-4">
      <div
        v-for="row in [
          [t('consul.ui.datacenter'), identity?.datacenter || capabilities?.datacenter || '-'],
          [t('consul.ui.agentNode'), identity?.node || capabilities?.nodeName || '-'],
          [t('consul.ui.agentAddress'), identity?.address || '-'],
          [t('consul.ui.version'), identity?.version || capabilities?.version || '-'],
          [t('consul.ui.mode'), (identity?.server ?? capabilities?.server) == null ? '-' : (identity?.server ?? capabilities?.server) ? t('consul.ui.server') : t('consul.ui.client')],
          [t('consul.ui.leader'), leader || '-'],
          [t('consul.ui.raftPeers'), String(peers.length)],
          [t('consul.ui.membersAlive'), memberSummary],
        ]"
        :key="row[0]"
        class="min-h-16 border-b border-r p-3"
      >
        <div class="text-xs text-muted-foreground">{{ row[0] }}</div>
        <div class="mt-1 truncate text-sm font-medium" :title="row[1]">{{ row[1] }}</div>
      </div>
    </div>
    <div class="mt-4 grid border-l border-t sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="key in probeKeys" :key="key" class="flex min-h-10 items-center justify-between gap-3 border-b border-r px-3 py-2 text-xs">
        <span class="truncate font-medium">{{ probeLabel(key) }}</span>
        <span class="shrink-0" :class="probeStates[key] === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : probeStates[key] === 'loading' ? 'text-muted-foreground' : probeStates[key] === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'" :title="errors[key] || undefined">
          {{ probeStateLabel(probeStates[key]) }}
        </span>
      </div>
    </div>
    <div v-if="Object.keys(errors).length" class="mt-4 divide-y border">
      <div v-for="(error, source) in errors" :key="source" class="flex gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <strong class="mr-1">{{ source }}</strong
          >{{ error }}
        </div>
      </div>
    </div>
    <div v-if="autopilotHealth?.fields.length" class="mt-4 overflow-hidden border">
      <div class="border-b bg-muted/30 px-3 py-2 text-xs font-medium">{{ t("consul.ui.autopilotHealth") }}</div>
      <dl class="grid sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="field in autopilotHealth.fields" :key="field.name" class="min-w-0 border-b border-r px-3 py-2 text-xs">
          <dt class="truncate text-muted-foreground">{{ field.name }}</dt>
          <dd class="mt-1 truncate font-medium" :title="field.value">{{ field.value }}</dd>
        </div>
      </dl>
    </div>
    <div class="mt-4 overflow-hidden border">
      <div class="border-b bg-muted/30 px-3 py-2 text-xs font-medium">{{ t("consul.ui.members") }}</div>
      <table class="w-full table-fixed text-xs">
        <thead>
          <tr class="border-b text-left text-muted-foreground">
            <th class="px-3 py-2">{{ t("consul.ui.node") }}</th>
            <th class="px-3 py-2">{{ t("consul.ui.address") }}</th>
            <th class="w-24 px-3 py-2">{{ t("consul.ui.status") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="member in members" :key="`${member.Name}-${member.Addr}`" class="border-b last:border-0">
            <td class="truncate px-3 py-2">{{ member.Name }}</td>
            <td class="truncate px-3 py-2">{{ member.Addr }}:{{ member.Port }}</td>
            <td class="px-3 py-2">{{ member.Status === 1 ? t("consul.ui.alive") : member.Status === 2 ? t("consul.ui.leaving") : t("consul.ui.failed") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
