<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "@lucide/vue";
import { loadLdapLoginConfig, saveLdapLoginConfig, testLdapLoginConfig } from "@/lib/backend/api";

const { t } = useI18n();

interface LdapSettingsDraft {
  enabled: boolean;
  name: string;
  host: string;
  port: number;
  useTls: boolean;
  baseDn: string;
  requireServiceAccount: boolean;
  serviceAccountDn: string;
  serviceAccountPassword: string;
  searchFilter: string;
  connectTimeoutSecs: number;
}

const DEFAULT_DRAFT: LdapSettingsDraft = {
  enabled: false,
  name: "",
  host: "",
  port: 389,
  useTls: false,
  baseDn: "",
  requireServiceAccount: false,
  serviceAccountDn: "",
  serviceAccountPassword: "",
  searchFilter: "",
  connectTimeoutSecs: 10,
};

const form = ref<LdapSettingsDraft>({ ...DEFAULT_DRAFT });
const serviceAccountPasswordSet = ref(false);
const loading = ref(false);
const testing = ref(false);
const saving = ref(false);
const message = ref("");
const messageError = ref(false);

async function load() {
  loading.value = true;
  message.value = "";
  messageError.value = false;
  try {
    const config = await loadLdapLoginConfig();
    form.value = {
      enabled: config.enabled,
      name: config.name,
      host: config.host,
      port: config.port,
      useTls: config.useTls,
      baseDn: config.baseDn,
      requireServiceAccount: config.requireServiceAccount,
      serviceAccountDn: config.serviceAccountDn,
      serviceAccountPassword: "",
      searchFilter: config.searchFilter,
      connectTimeoutSecs: config.connectTimeoutSecs || 10,
    };
    serviceAccountPasswordSet.value = config.serviceAccountPasswordSet;
  } catch (e: any) {
    message.value = e?.message || t("auth.ldapLoadFailed");
    messageError.value = true;
  } finally {
    loading.value = false;
  }
}

function toPayload(): LdapSettingsDraft {
  return { ...form.value };
}

async function test() {
  testing.value = true;
  message.value = "";
  messageError.value = false;
  try {
    const result = await testLdapLoginConfig(toPayload());
    if (result.ok) {
      message.value = result.message || t("auth.ldapTestSuccess");
      messageError.value = false;
    } else {
      message.value = result.error || t("auth.ldapTestFailed");
      messageError.value = true;
    }
  } catch (e: any) {
    message.value = e?.message || t("auth.ldapTestFailed");
    messageError.value = true;
  } finally {
    testing.value = false;
  }
}

async function readError(e: any): Promise<string> {
  const raw = e?.message ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON — fall through to the raw message
  }
  return raw || t("auth.ldapTestFailed");
}

async function save() {
  saving.value = true;
  message.value = "";
  messageError.value = false;
  try {
    await saveLdapLoginConfig(toPayload());
    if (form.value.serviceAccountPassword) {
      serviceAccountPasswordSet.value = true;
      form.value.serviceAccountPassword = "";
    }
    message.value = t("auth.ldapSaveSuccess");
    messageError.value = false;
  } catch (e: any) {
    message.value = await readError(e);
    messageError.value = true;
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-1.5">
      <Label class="text-base">{{ t("auth.ldapSettingsTitle") }}</Label>
      <p class="text-sm text-muted-foreground">{{ t("auth.ldapSettingsDescription") }}</p>
    </div>

    <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
      <div class="space-y-1">
        <Label for="ldap-login-enabled">{{ t("auth.ldapEnabled") }}</Label>
      </div>
      <Switch id="ldap-login-enabled" v-model="form.enabled" />
    </div>

    <div v-if="form.enabled" class="space-y-4">
      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-1.5">
          <Label for="ldap-host">{{ t("auth.ldapHost") }}</Label>
          <Input id="ldap-host" v-model="form.host" :placeholder="t('auth.ldapHostPlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="ldap-port">{{ t("auth.ldapPort") }}</Label>
          <Input id="ldap-port" v-model.number="form.port" type="number" />
        </div>
        <div class="flex items-end">
          <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2 w-full">
            <Label for="ldap-use-tls">{{ t("auth.ldapUseTls") }}</Label>
            <Switch id="ldap-use-tls" v-model="form.useTls" />
          </div>
        </div>
        <div class="space-y-1.5 md:col-span-2">
          <Label for="ldap-base-dn">{{ t("auth.ldapBaseDn") }}</Label>
          <Input id="ldap-base-dn" v-model="form.baseDn" :placeholder="t('auth.ldapBaseDnPlaceholder')" />
        </div>
      </div>

      <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
        <div class="space-y-1">
          <Label for="ldap-require-service-account">{{ t("auth.ldapRequireServiceAccount") }}</Label>
          <p class="text-xs text-muted-foreground">{{ t("auth.ldapRequireServiceAccountHint") }}</p>
        </div>
        <Switch id="ldap-require-service-account" v-model="form.requireServiceAccount" />
      </div>

      <template v-if="form.requireServiceAccount">
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="ldap-service-account-dn">{{ t("auth.ldapServiceAccountDn") }}</Label>
            <Input id="ldap-service-account-dn" v-model="form.serviceAccountDn" :placeholder="t('auth.ldapServiceAccountDnPlaceholder')" />
          </div>
          <div class="space-y-1.5">
            <Label for="ldap-service-account-password">{{ t("auth.ldapServiceAccountPassword") }}</Label>
            <PasswordInput id="ldap-service-account-password" v-model="form.serviceAccountPassword" :placeholder="serviceAccountPasswordSet ? t('auth.ldapServiceAccountPasswordSet') : ''" inputClass="h-9" autocomplete="off" />
          </div>
          <div class="space-y-1.5">
            <Label for="ldap-search-filter">{{ t("auth.ldapSearchFilter") }}</Label>
            <Input id="ldap-search-filter" v-model="form.searchFilter" :placeholder="t('auth.ldapSearchFilterPlaceholder')" />
          </div>
        </div>
      </template>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="form.enabled" variant="outline" :disabled="testing" @click="test">
        <Loader2 v-if="testing" class="mr-1 h-3.5 w-3.5 animate-spin" />
        {{ t("auth.ldapTest") }}
      </Button>
      <Button :disabled="saving" @click="save">
        <Loader2 v-if="saving" class="mr-1 h-3.5 w-3.5 animate-spin" />
        {{ t("auth.ldapSave") }}
      </Button>
    </div>

    <p v-if="loading" class="text-sm text-muted-foreground">{{ t("auth.processing") }}</p>
    <p v-else-if="message" class="text-sm" :class="messageError ? 'text-destructive' : 'text-green-500'">{{ message }}</p>
  </div>
</template>
