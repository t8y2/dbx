<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ExternalLink } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { permittedPluginUrl } from "@/lib/plugins/pluginOpenUrl";

const props = defineProps<{ pluginId: string; pluginName: string; permissions?: readonly string[] }>();
const { t } = useI18n();
const url = ref("");
const open = ref(false);
const error = ref("");
const opening = ref(false);
let settle: ((result: { opened: boolean }) => void) | undefined;
function cancel() {
  open.value = false;
  const resolve = settle;
  settle = undefined;
  resolve?.({ opened: false });
}
function request(value: string): Promise<{ opened: boolean }> {
  if (settle || opening.value) return Promise.reject(new Error("A plugin URL request is already awaiting consent or opening"));
  url.value = permittedPluginUrl(value, props.permissions);
  error.value = "";
  open.value = true;
  return new Promise((resolve) => {
    settle = resolve;
  });
}
async function approve(event: MouseEvent) {
  const resolve = settle;
  try {
    const target = permittedPluginUrl(url.value, props.permissions);
    if (isTauriRuntime()) {
      event.preventDefault();
      opening.value = true;
      const { open } = await import("@tauri-apps/plugin-shell");
      if (!resolve || settle !== resolve) return;
      await open(permittedPluginUrl(target, props.permissions));
    }
    // Web navigation stays on this trusted anchor click, preserving activation.
    if (!resolve || settle !== resolve) return;
    settle = undefined;
    open.value = false;
    resolve?.({ opened: true });
  } catch (cause) {
    event.preventDefault();
    if (settle === resolve) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    opening.value = false;
  }
}
watch(() => JSON.stringify([props.pluginId, props.permissions]), cancel);
watch(open, (value) => {
  if (!value) cancel();
});
onBeforeUnmount(cancel);
defineExpose({ request, cancel });
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="w-[calc(100vw-2rem)] max-w-lg">
      <DialogHeader
        ><DialogTitle>{{ t("pluginPlatform.openUrlTitle") }}</DialogTitle
        ><DialogDescription class="break-words">{{ t("pluginPlatform.openUrlPrompt", { name: pluginName }) }}</DialogDescription></DialogHeader
      >
      <p class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-3 font-mono text-sm" dir="ltr">{{ url }}</p>
      <p v-if="error" class="break-words text-sm text-destructive" role="alert">{{ error }}</p>
      <DialogFooter>
        <Button variant="outline" :disabled="opening" @click="cancel">{{ t("common.cancel") }}</Button>
        <Button as-child :disabled="opening"
          ><a :href="url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" :aria-disabled="opening" @click="opening ? $event.preventDefault() : approve($event)"><ExternalLink class="h-4 w-4" />{{ t("grid.openUrl") }}</a></Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
