<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import JsonTree from "@/components/common/JsonTree.vue";
import { copyToClipboard } from "@/lib/common/clipboard";
import * as api from "@/lib/backend/api";
import { decodeRedisPluginValue, listRedisPluginCodecs, type RedisPluginCodec, type RedisPluginCodecContext, type RedisPluginDecodedValue } from "@/lib/redis/redisPluginCodec";

const props = defineProps<{ rawBase64: string; context: RedisPluginCodecContext }>();
const { t } = useI18n();
const codecs = shallowRef<RedisPluginCodec[]>([]);
const selected = ref("");
const result = shallowRef<RedisPluginDecodedValue | null>(null);
const error = ref("");
const loading = ref(false);
const discovering = ref(false);
let revision = 0;
let disposed = false;
const selectedCodec = computed(() => codecs.value.find((codec) => codec.key === selected.value));

async function copyResult() {
  if (!result.value) return;
  try {
    await copyToClipboard(result.value.format === "text" ? String(result.value.value) : JSON.stringify(result.value.value, null, 2));
  } catch (cause) {
    error.value = String(cause);
  }
}

async function discover() {
  discovering.value = true;
  error.value = "";
  try {
    const available = listRedisPluginCodecs(await api.listPlugins());
    if (disposed) return;
    codecs.value = available;
    if (!available.some((codec) => codec.key === selected.value)) selected.value = "";
  } catch (cause) {
    if (!disposed) error.value = String(cause);
  } finally {
    if (!disposed) discovering.value = false;
  }
}

async function decode() {
  const current = ++revision;
  result.value = null;
  error.value = "";
  const codec = selectedCodec.value;
  if (!codec) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    // Only the explicitly selected payload crosses the plugin boundary. No
    // credentials, connection configuration or host driver are passed.
    const decoded = await decodeRedisPluginValue(api.invokePlugin, codec, props.rawBase64, props.context);
    if (!disposed && current === revision) result.value = decoded;
  } catch (cause) {
    if (!disposed && current === revision) error.value = String(cause);
  } finally {
    if (!disposed && current === revision) loading.value = false;
  }
}

watch(
  () => [selected.value, props.rawBase64, props.context.db, props.context.keyRaw, props.context.redisType],
  () => void decode(),
);
onMounted(() => void discover());
onBeforeUnmount(() => {
  disposed = true;
  revision++;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden" data-redis-plugin-codec>
    <div class="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs">
      <Select v-model="selected" :disabled="discovering">
        <SelectTrigger class="h-7 w-72" :aria-label="t('redis.pluginCodecChoose')"><SelectValue :placeholder="t('redis.pluginCodecChoose')" /></SelectTrigger>
        <SelectContent
          ><SelectItem v-for="codec in codecs" :key="codec.key" :value="codec.key">{{ codec.label }}</SelectItem></SelectContent
        >
      </Select>
      <Button variant="outline" size="sm" :disabled="loading || !selectedCodec" @click="decode">{{ t("redis.pluginCodecDecode") }}</Button>
      <Button variant="ghost" size="sm" :disabled="discovering || loading" @click="discover">{{ t("redis.pluginCodecRefresh") }}</Button>
      <Button variant="ghost" size="sm" :disabled="!result || loading" @click="copyResult">{{ t("redis.pluginCodecCopy") }}</Button>
      <span class="text-muted-foreground">{{ t("redis.pluginCodecReadOnly") }}</span>
    </div>
    <p v-if="error" role="alert" class="shrink-0 whitespace-pre-wrap break-words border-b p-4 text-sm text-destructive">{{ error }}</p>
    <p v-if="loading || discovering" role="status" class="p-4 text-sm text-muted-foreground">{{ t("redis.pluginCodecLoading") }}</p>
    <div v-else-if="result" class="min-h-0 flex-1 overflow-auto p-4 text-sm">
      <JsonTree v-if="result.format === 'json'" :value="result.value" virtualized />
      <pre v-else class="whitespace-pre-wrap break-words">{{ result.value }}</pre>
    </div>
    <p v-else-if="!codecs.length && !error" class="p-4 text-sm text-muted-foreground">{{ t("redis.pluginCodecEmpty") }}</p>
    <p v-else-if="!selected && !error" class="p-4 text-sm text-muted-foreground">{{ t("redis.pluginCodecChoose") }}</p>
  </div>
</template>
