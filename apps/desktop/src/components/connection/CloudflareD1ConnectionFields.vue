<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordInput from "@/components/ui/PasswordInput.vue";

const accountId = defineModel<string>("accountId", { required: true });
const databaseId = defineModel<string | undefined>("databaseId");
const apiToken = defineModel<string>("apiToken", { required: true });
const { t } = useI18n();
</script>

<template>
  <div class="grid grid-cols-4 items-center gap-4">
    <Label class="justify-self-start text-left">{{ t("connection.d1AccountId") }}</Label>
    <Input v-model="accountId" class="col-span-3" placeholder="023e105f4ecef8ad9ca31a8372d0c353" />
  </div>

  <div class="grid grid-cols-4 items-center gap-4">
    <Label class="justify-self-start text-left">{{ t("connection.d1DatabaseId") }}</Label>
    <Input v-model="databaseId" class="col-span-3" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
  </div>

  <div class="grid grid-cols-4 items-center gap-4">
    <Label class="justify-self-start text-left">{{ t("connection.d1ApiToken") }}</Label>
    <PasswordInput v-model="apiToken" class="col-span-3" placeholder="Cloudflare API Token" />
  </div>

  <div class="grid grid-cols-4 items-start gap-4">
    <span />
    <p class="col-span-3 text-xs text-muted-foreground">{{ t("connection.d1TokenHint") }}</p>
  </div>
</template>
