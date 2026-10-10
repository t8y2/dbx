<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import OracleSecurityAdmin from "./OracleSecurityAdmin.vue";
import { supportsOracleSecurity } from "@/lib/database/oracleSecurity";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection?: ConnectionConfig; owner?: string; objectName: string }>();
const { locale } = useI18n();
const title = computed(() => (locale.value.startsWith("zh") ? "对象权限" : "Object grants"));
const open = ref(false);
watch(
  () => [props.connection?.id, props.owner, props.objectName],
  () => {
    open.value = false;
  },
);
</script>

<template>
  <template v-if="supportsOracleSecurity(connection) && owner && objectName">
    <Button size="sm" variant="outline" data-structure-object-grants @click="open = true">{{ title }}</Button>
    <Dialog v-model:open="open">
      <DialogContent class="max-h-[85vh] max-w-5xl overflow-auto">
        <DialogHeader
          ><DialogTitle>{{ title }} · {{ owner }}.{{ objectName }}</DialogTitle></DialogHeader
        >
        <OracleSecurityAdmin v-if="open && connection" :key="`${connection.id}:${owner}:${objectName}`" :connection="connection" :object-scope="{ owner, name: objectName }" />
      </DialogContent>
    </Dialog>
  </template>
</template>
