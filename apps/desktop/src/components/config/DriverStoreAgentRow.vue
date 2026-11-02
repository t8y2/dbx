<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Clock3, Download, FileUp, Loader2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import DriverInstallProgressCircle from "@/components/config/DriverInstallProgressCircle.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import type { AgentDriverInfo } from "@/lib/backend/api";

const props = withDefaults(
  defineProps<{
    driver: AgentDriverInfo;
    showCategoryBadge?: boolean;
    categoryLabel?: string;
    highlighted?: boolean;
    sizeLabel: string;
    requiresJavaRuntime: boolean;
    queued: boolean;
    progressActive: boolean;
    progressCancellable: boolean;
    progressPercent: number | null;
    progressText: string;
    managedJdbc: boolean;
    importing: boolean;
    packageBusy: boolean;
    preparingUpgradeAll: boolean;
    upgradingAll: boolean;
    installing: boolean;
  }>(),
  {
    showCategoryBadge: false,
    categoryLabel: "",
    highlighted: false,
  },
);

const emit = defineEmits<{
  install: [];
  uninstall: [];
  importFile: [];
  cancelInstall: [];
  removeQueue: [];
}>();

const { t } = useI18n();

const progressTitle = computed(() => props.progressText || t(props.driver.installed && props.driver.update_available ? "driverStore.updating" : "driverStore.installing"));
const queueOrUpgradeBusy = computed(() => props.preparingUpgradeAll || props.upgradingAll || props.packageBusy);
const uninstallBusy = computed(() => props.installing || props.preparingUpgradeAll || props.upgradingAll || props.packageBusy || props.queued);
</script>

<template>
  <div
    :data-driver-store-focus="`driver:${driver.db_type}`"
    class="driver-store-agent-row flex items-center gap-3 px-4 py-2 transition hover:bg-muted/30"
    :class="{
      'driver-store-focus-highlight': highlighted,
      'driver-store-agent-row--installed': driver.installed,
    }"
  >
    <span class="relative flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 shrink-0">
      <DatabaseIcon :db-type="driver.db_type" class="h-4 w-4" />
      <span v-if="driver.installed" class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-1 ring-background" aria-hidden="true">
        <Check class="h-2.5 w-2.5 text-green-600" />
      </span>
    </span>
    <div class="driver-store-agent-name min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <div class="truncate text-sm font-medium">{{ driver.label }}</div>
        <span v-if="driver.installed" class="driver-store-installed-badge shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400">{{ t("driverStore.installedBadge") }}</span>
      </div>
    </div>
    <span v-if="showCategoryBadge && categoryLabel" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ categoryLabel }}</span>
    <div class="driver-store-agent-meta flex shrink-0 items-center gap-1.5">
      <span v-if="requiresJavaRuntime && driver.jre" class="rounded-full px-2 py-0.5 text-[11px]" :class="driver.jre !== '21' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'">JRE {{ driver.jre }}</span>
      <span v-if="driver.installed" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.installed_version }}</span>
      <span v-if="driver.installed && driver.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ driver.version }}</span>
      <span v-if="!driver.installed && driver.version" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.version }}</span>
      <span v-if="sizeLabel" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ sizeLabel }}</span>
    </div>
    <div class="driver-store-agent-actions flex shrink-0 items-center gap-2">
      <Button v-if="!driver.installed && queued" size="sm" variant="outline" class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15" :disabled="queueOrUpgradeBusy" @click="emit('removeQueue')">
        <Clock3 class="h-3 w-3 mr-1" />
        {{ t("driverStore.queued") }}
      </Button>
      <DriverInstallProgressCircle v-else-if="!driver.installed && progressActive" :percent="progressPercent" :title="progressTitle" />
      <Button
        v-if="!driver.installed && progressActive && progressCancellable"
        type="button"
        variant="ghost"
        size="icon-sm"
        class="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive"
        :title="t('driverStore.cancelInstall')"
        :aria-label="t('driverStore.cancelInstall')"
        @click="emit('cancelInstall')"
      >
        <X class="h-3.5 w-3.5" />
      </Button>
      <Button v-else-if="!driver.installed && !progressActive && !queued" size="sm" class="h-7 rounded-md text-xs" :disabled="queueOrUpgradeBusy" @click="emit('install')">
        <Download class="h-3 w-3 mr-1" />
        {{ t("driverStore.install") }}
      </Button>
      <Button
        v-if="!driver.installed && !managedJdbc && !progressActive && !queued"
        size="sm"
        variant="ghost"
        class="driver-store-local-import-button h-7 w-7 rounded-md text-xs text-muted-foreground"
        :title="importing ? t('driverStore.importing') : t('driverStore.importLocalJar')"
        :disabled="preparingUpgradeAll || upgradingAll || installing || packageBusy"
        @click="emit('importFile')"
      >
        <Loader2 v-if="importing" class="h-3.5 w-3.5 animate-spin" />
        <FileUp v-else class="h-3.5 w-3.5" />
      </Button>
      <Button v-if="driver.installed && driver.update_available && queued" size="sm" variant="outline" class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15" :disabled="queueOrUpgradeBusy" @click="emit('removeQueue')">
        <Clock3 class="h-3 w-3 mr-1" />
        {{ t("driverStore.queued") }}
      </Button>
      <DriverInstallProgressCircle v-else-if="driver.installed && driver.update_available && progressActive" :percent="progressPercent" :title="progressTitle" />
      <Button
        v-if="driver.installed && driver.update_available && progressActive && progressCancellable"
        type="button"
        variant="ghost"
        size="icon-sm"
        class="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive"
        :title="t('driverStore.cancelInstall')"
        :aria-label="t('driverStore.cancelInstall')"
        @click="emit('cancelInstall')"
      >
        <X class="h-3.5 w-3.5" />
      </Button>
      <Button v-else-if="driver.installed && driver.update_available && !progressActive && !queued" size="sm" variant="outline" class="h-7 rounded-md text-xs" :disabled="queueOrUpgradeBusy" @click="emit('install')">
        {{ t("driverStore.update") }}
      </Button>
      <Button v-if="driver.installed" variant="ghost" size="sm" class="h-7 rounded-md text-xs text-muted-foreground hover:text-destructive" :disabled="uninstallBusy" @click="emit('uninstall')">
        {{ t("driverStore.uninstall") }}
      </Button>
    </div>
  </div>
</template>
