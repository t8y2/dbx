<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { watch } from "vue";
import type { TransferDatabaseLinkConfig } from "@/lib/backend/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

defineProps<{ oceanbaseTarget: boolean }>();
const config = defineModel<TransferDatabaseLinkConfig>({ required: true });
const password = defineModel<string>("password", { default: "" });
const { t } = useI18n();
watch(() => config.value.protocol, (protocol) => {
  if (protocol === "OCI") {
    config.value.tenant = "oracle";
    config.value.cluster = "";
  }
});
</script>

<template>
  <div class="space-y-2 rounded-md border p-3 text-xs">
    <p class="font-medium">{{ config.sourceOwner }} / {{ config.name }}</p>
    <p class="text-muted-foreground">{{ t("transfer.databaseLinkAuthHint") }}</p>
    <div class="grid grid-cols-2 gap-2">
      <Label class="space-y-1">{{ t("databaseLinks.name") }}<Input v-model="config.targetName" class="h-7 text-xs" /></Label>
      <div class="space-y-1">
        <Label>{{ t("transfer.databaseLinkScope") }}</Label>
        <Select v-model="config.targetScope"><SelectTrigger class="h-7 text-xs"><SelectValue :placeholder="t('transfer.databaseLinkChooseScope')" /></SelectTrigger><SelectContent>
          <SelectItem v-if="!oceanbaseTarget" value="private">{{ t("transfer.databaseLinkPrivate") }}</SelectItem>
          <SelectItem v-if="!oceanbaseTarget" value="public">{{ t("databaseLinks.public") }}</SelectItem>
          <SelectItem v-if="oceanbaseTarget" value="tenant">{{ t("transfer.databaseLinkTenantVisible") }}</SelectItem>
        </SelectContent></Select>
      </div>
      <Label class="space-y-1">{{ t("databaseLinks.username") }}<Input v-model="config.username" class="h-7 text-xs" autocomplete="off" /></Label>
      <Label class="space-y-1">{{ t("databaseLinks.password") }}<Input v-model="password" type="password" class="h-7 text-xs" autocomplete="new-password" /></Label>
      <Label class="col-span-2 space-y-1">{{ t("databaseLinks.host") }}<Input v-model="config.host" class="h-7 text-xs" autocomplete="off" /></Label>
      <template v-if="oceanbaseTarget">
        <div class="space-y-1"><Label>{{ t("databaseLinks.remoteProtocol") }}</Label><Select v-model="config.protocol"><SelectTrigger class="h-7 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="OB">OB</SelectItem><SelectItem value="OCI">OCI</SelectItem></SelectContent></Select></div>
        <Label v-if="config.protocol === 'OB'" class="space-y-1">{{ t("databaseLinks.remoteTenant") }}<Input v-model="config.tenant" class="h-7 text-xs" /></Label>
        <Label v-if="config.protocol === 'OB'" class="space-y-1">{{ t("databaseLinks.remoteCluster") }}<Input v-model="config.cluster" class="h-7 text-xs" /></Label>
      </template>
    </div>
    <p class="text-muted-foreground">{{ t("transfer.databaseLinkNoRemoteTest") }}</p>
  </div>
</template>
