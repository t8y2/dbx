<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import { useTheme } from "@/composables/useTheme";
import { webPath } from "@/lib/common/webPath";
import { databaseIconAssetName, normalizeDatabaseIconType } from "@/lib/database/databaseIconAssets";

const props = defineProps<{
  dbType?: string;
}>();
const { isDark } = useTheme();

const normalizedType = computed(() => normalizeDatabaseIconType(props.dbType));
const assetName = computed(() => databaseIconAssetName(normalizedType.value));
const useLightIconInDarkMode = computed(() => normalizedType.value === "easysearch" && isDark.value);
const brightenInceptorInDarkMode = computed(() => isDark.value && (normalizedType.value === "transwarp" || normalizedType.value === "transwarp_inceptor"));
const assetSrc = computed(() => {
  if (!assetName.value) return "";
  if (normalizedType.value === "uxdb" && isDark.value) return webPath("/icons/database/uxdb-dark.svg");
  return webPath(assetName.value.includes(".") ? `/icons/database/${assetName.value}` : `/icons/database/${assetName.value}.svg`);
});
</script>

<template>
  <img
    v-if="assetName"
    :src="assetSrc"
    alt=""
    class="database-logo object-contain"
    :class="{ 'database-logo-light': useLightIconInDarkMode, 'database-logo-inceptor-dark': brightenInceptorInDarkMode, 'database-logo-impala': normalizedType === 'impala', 'database-logo-solr': normalizedType === 'solr' }"
    aria-hidden="true"
  />
  <Database v-else class="text-blue-400" />
</template>

<style scoped>
.database-logo {
  transform: scale(1.35);
  transform-origin: center;
}

.database-logo-light {
  filter: brightness(0) invert(82%);
}

.database-logo-inceptor-dark {
  filter: brightness(1.6);
}

.database-logo-impala {
  transform: scale(1.55);
}

/* solr.svg 的图形撑满整个 viewBox（无内边距），其他 logo 留白约 20-25%，
   统一 scale(1.35) 下视觉偏大，单独收敛到与多数 logo 一致的占幅。 */
.database-logo-solr {
  transform: scale(1.02);
}
</style>
