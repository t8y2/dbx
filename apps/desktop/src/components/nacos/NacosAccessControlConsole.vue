<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { KeyRound, Loader2, RefreshCw, ShieldCheck, UsersRound } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import NacosAccessControl from "@/components/nacos/NacosAccessControl.vue";
import NacosRoleAccessControl from "@/components/nacos/NacosRoleAccessControl.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import type { NacosConnectionInfo } from "@/types/nacos";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
}>();

type AccessTab = "users" | "roles";
type AccessControlWorkspace = { refresh: () => Promise<void> };

const { t } = useI18n();
const connectionStore = useConnectionStore();
const connectionInfo = ref<NacosConnectionInfo | null>(null);
const connectionError = ref("");
const loading = ref(false);
const activeTab = ref<AccessTab>("users");
const legacyWorkspace = ref<AccessControlWorkspace | null>(null);
const enhancedWorkspaceRef = ref<AccessControlWorkspace | null>(null);

const accessControl = computed(() => connectionInfo.value?.capabilities.accessControl);
const supportsUsers = computed(() => accessControl.value?.listUsers.supported === true);
const supportsRoles = computed(() => accessControl.value?.mode === "roleBindings" && accessControl.value.listRoleBindings.supported === true);
const enhancedWorkspace = computed(() => accessControl.value?.enhancedWorkspace === true);
const permissionWorkspaceUnavailable = computed(() => accessControl.value?.mode === "roleBindings" && accessControl.value.listPermissions?.supported === false && accessControl.value.listPermissions.reason !== "versionUnsupported");

async function loadConnectionInfo(refreshWorkspace = false) {
  loading.value = true;
  connectionError.value = "";
  try {
    await connectionStore.ensureConnected(props.connectionId);
    connectionInfo.value = await api.nacosTestConnection(props.connectionId, refreshWorkspace);
    if (!supportsUsers.value && supportsRoles.value) activeTab.value = "roles";
    if (refreshWorkspace) {
      await nextTick();
      await (enhancedWorkspace.value ? enhancedWorkspaceRef.value : legacyWorkspace.value)?.refresh();
    }
  } catch (error) {
    connectionInfo.value = null;
    connectionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.connectionId,
  () => void loadConnectionInfo(),
  { immediate: true },
);
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-background">
    <header class="flex h-14 shrink-0 flex-wrap items-center gap-3 border-b px-4">
      <div class="flex rounded-md border p-0.5 shadow-sm">
        <Button size="sm" class="h-8 gap-1.5 px-3 text-sm" :variant="activeTab === 'users' ? 'secondary' : 'ghost'" :disabled="!supportsUsers" @click="activeTab = 'users'">
          <UsersRound class="h-4 w-4" />
          {{ t("nacos.users") }}
        </Button>
        <Button v-if="supportsRoles" size="sm" class="h-8 gap-1.5 px-3 text-sm" :variant="activeTab === 'roles' ? 'secondary' : 'ghost'" @click="activeTab = 'roles'">
          <KeyRound class="h-4 w-4" />
          {{ t("nacos.roleBindings") }}
        </Button>
      </div>
      <div class="hidden h-5 w-px bg-border sm:block" />
      <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck class="h-3.5 w-3.5 shrink-0 text-sky-600" />
        <span class="font-medium text-foreground/75">{{ t("nacos.accessControlTitle") }}</span>
        <span class="hidden truncate lg:inline">{{ t("nacos.accessControlDescription") }}</span>
      </div>
      <Badge v-if="connectionInfo?.serverVersion" variant="secondary">{{ connectionInfo.serverVersion }}</Badge>
      <div class="flex-1" />
      <Badge v-if="readOnly" variant="outline">{{ t("nacos.readOnly") }}</Badge>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="loadConnectionInfo(true)">
        <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
        {{ t("nacos.refresh") }}
      </Button>
    </header>

    <div v-if="permissionWorkspaceUnavailable" class="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">{{ t("nacos.accessPermissionEndpointUnavailable") }}</div>
    <div v-if="connectionError" class="mx-4 mt-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ connectionError }}</div>
    <div v-else-if="loading && !connectionInfo" class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      <Loader2 class="mr-2 h-4 w-4 animate-spin" />
      {{ t("nacos.loading") }}
    </div>
    <template v-else-if="connectionInfo">
      <div v-if="!supportsUsers && !supportsRoles" class="m-4 rounded border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{{ t("nacos.accessControlUnavailable") }}</div>
      <NacosRoleAccessControl v-if="enhancedWorkspace && accessControl" ref="enhancedWorkspaceRef" :connection-id="connectionId" :capabilities="accessControl" :read-only="readOnly" :tab="activeTab" @select-user="activeTab = 'users'" @select-role="activeTab = 'roles'" />
      <NacosAccessControl v-else-if="supportsUsers || supportsRoles" ref="legacyWorkspace" :connection-id="connectionId" :connection-info="connectionInfo" :read-only="readOnly" :tab="activeTab" />
    </template>
  </section>
</template>
