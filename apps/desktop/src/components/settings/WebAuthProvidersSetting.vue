<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, ShieldAlert, Trash2 } from "@lucide/vue";
import { apiUrl } from "@/lib/common/webPath";

/**
 * External auth provider management (LDAP / HTTP callback) under `Settings → Security`.
 *
 * - env-sourced entries (DBX_AUTH_CONFIG) are rendered read-only;
 * - secret fields (bind password / shared secret) render a "configured" placeholder; leaving them empty keeps
 *   the stored value, a new value overwrites it, and clearing it removes the secret;
 * - saving goes through the PUT full-replace endpoint, after which the server hot-reloads the provider registry.
 */
const { t } = useI18n();

interface ProviderView {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  sort_order: number;
  source: "env" | "db";
  config: Record<string, unknown>;
  has_secrets: string[];
}

interface Draft {
  id: string;
  kind: "ldap" | "http_callback";
  label: string;
  enabled: boolean;
  sort_order: number;
  url: string;
  start_tls: boolean;
  bind_dn: string;
  bind_password: string;
  base_dn: string;
  user_filter: string;
  username_attr: string;
  display_name_attr: string;
  email_attr: string;
  group_attr: string;
  shared_secret: string;
  timeout_secs: number;
  role_map_text: string;
  default_role: "member" | "admin";
  /** Secrets the server reports as configured (drives the keep-existing placeholder). */
  existing_secrets: string[];
}

const providers = ref<ProviderView[]>([]);
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const message = ref("");
const messageIsError = ref(false);
const editingDraft = ref<Draft | null>(null);
/** Non-null alias for the form template: the v-else branch guarantees editingDraft is set (the @click null assignment breaks vue-tsc narrowing). */
const draft = computed(() => editingDraft.value!);
const editingIsNew = ref(false);

function roleMapToText(map: Record<string, unknown> | undefined): string {
  if (!map) return "";
  return Object.entries(map)
    .map(([group, role]) => `${group}=${role}`)
    .join("\n");
}

function textToRoleMap(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    map[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return map;
}

function draftFromView(view: ProviderView): Draft {
  const config = view.config ?? {};
  const str = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  const num = (key: string, fallback: number) => (typeof config[key] === "number" ? (config[key] as number) : fallback);
  return {
    id: view.id,
    kind: view.kind === "http_callback" ? "http_callback" : "ldap",
    label: view.label,
    enabled: view.enabled,
    sort_order: view.sort_order,
    url: str("url"),
    start_tls: config.start_tls === true,
    bind_dn: str("bind_dn"),
    bind_password: "",
    base_dn: str("base_dn"),
    user_filter: str("user_filter") || "(uid={username})",
    username_attr: str("username_attr") || "uid",
    display_name_attr: str("display_name_attr") || "displayName",
    email_attr: str("email_attr") || "mail",
    group_attr: str("group_attr") || "memberOf",
    shared_secret: "",
    timeout_secs: num("timeout_secs", 10),
    role_map_text: roleMapToText(config.role_map as Record<string, unknown>),
    default_role: config.default_role === "admin" ? "admin" : "member",
    existing_secrets: view.has_secrets ?? [],
  };
}

function newDraft(kind: "ldap" | "http_callback"): Draft {
  return {
    id: "",
    kind,
    label: "",
    enabled: true,
    sort_order: (providers.value.length + 1) * 10,
    url: "",
    start_tls: false,
    bind_dn: "",
    bind_password: "",
    base_dn: "",
    user_filter: "(uid={username})",
    username_attr: "uid",
    display_name_attr: "displayName",
    email_attr: "mail",
    group_attr: "memberOf",
    shared_secret: "",
    timeout_secs: 10,
    role_map_text: "",
    default_role: "member",
    existing_secrets: [],
  };
}

function draftConfig(draft: Draft): Record<string, unknown> {
  const config: Record<string, unknown> = {
    url: draft.url.trim(),
    timeout_secs: draft.timeout_secs,
    role_map: textToRoleMap(draft.role_map_text),
    default_role: draft.default_role,
  };
  if (draft.kind === "ldap") {
    config.start_tls = draft.start_tls;
    config.base_dn = draft.base_dn.trim();
    config.user_filter = draft.user_filter.trim() || "(uid={username})";
    config.username_attr = draft.username_attr.trim() || "uid";
    config.display_name_attr = draft.display_name_attr.trim() || "displayName";
    config.email_attr = draft.email_attr.trim() || "mail";
    config.group_attr = draft.group_attr.trim() || "memberOf";
    if (draft.bind_dn.trim()) config.bind_dn = draft.bind_dn.trim();
    if (draft.bind_password.trim()) config.bind_password = draft.bind_password;
  } else {
    if (draft.shared_secret.trim()) config.shared_secret = draft.shared_secret;
  }
  return config;
}

const canSaveDraft = computed(() => {
  const draft = editingDraft.value;
  if (!draft) return false;
  if (!draft.id.trim() || !draft.url.trim()) return false;
  if (draft.kind === "ldap" && !draft.base_dn.trim()) return false;
  return true;
});

async function load() {
  loading.value = true;
  try {
    const res = await fetch(apiUrl("/api/auth/admin/providers"), { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body = (await res.json()) as { providers?: ProviderView[] };
    providers.value = body.providers ?? [];
  } catch {
    // keep the current state when the server is unreachable
  } finally {
    loading.value = false;
  }
}

async function saveList(entries: { id: string; kind: string; label: string; enabled: boolean; sort_order: number; config: Record<string, unknown> }[]) {
  saving.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl("/api/auth/admin/providers"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: entries }),
    });
    if (res.ok) {
      messageIsError.value = false;
      message.value = t("settings.authProvidersSaved");
      await load();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      messageIsError.value = true;
      message.value = body.error || t("settings.authProvidersSaveFailed");
    }
  } catch (e: any) {
    messageIsError.value = true;
    message.value = e?.message || t("settings.authProvidersSaveFailed");
  } finally {
    saving.value = false;
  }
}

function dbEntries() {
  return providers.value
    .filter((provider) => provider.source === "db")
    .map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      label: provider.label,
      enabled: provider.enabled,
      sort_order: provider.sort_order,
      // The redacted config is sent back as-is (a null secret field → the server keeps the stored value).
      config: provider.config,
    }));
}

async function saveDraft() {
  const draft = editingDraft.value;
  if (!draft || !canSaveDraft.value) return;
  // Replace the db entry with the same id as the draft, keep the rest unchanged; secret fields are only submitted when a new value was typed.
  const others = dbEntries().filter((entry) => entry.id !== draft.id);
  await saveList([...others, { id: draft.id.trim(), kind: draft.kind, label: draft.label.trim() || draft.kind, enabled: draft.enabled, sort_order: draft.sort_order, config: draftConfig(draft) }]);
  editingDraft.value = null;
}

async function toggleEnabled(view: ProviderView) {
  if (view.source !== "db") return;
  const entries = dbEntries().map((entry) => (entry.id === view.id ? { ...entry, enabled: !view.enabled } : entry));
  await saveList(entries);
}

async function removeProvider(view: ProviderView) {
  if (view.source !== "db") return;
  if (!window.confirm(t("settings.authProvidersRemoveConfirm", { id: view.id }))) return;
  await saveList(dbEntries().filter((entry) => entry.id !== view.id));
}

async function testDraft() {
  const draft = editingDraft.value;
  if (!draft || !draft.url.trim()) return;
  testing.value = true;
  message.value = "";
  try {
    const res = await fetch(apiUrl("/api/auth/admin/providers/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: draft.kind, config: draftConfig(draft) }),
    });
    messageIsError.value = !res.ok;
    if (res.ok) {
      message.value = t("settings.authProvidersTestOk");
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      message.value = body.error || t("settings.authProvidersTestFailed");
    }
  } catch (e: any) {
    messageIsError.value = true;
    message.value = e?.message || t("settings.authProvidersTestFailed");
  } finally {
    testing.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="space-y-4" data-settings-search-id="web-auth-providers">
    <div class="flex items-center justify-between">
      <Label class="text-base">{{ t("settings.authProvidersTitle") }}</Label>
      <Loader2 v-if="loading || saving" class="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
    <p class="text-sm text-muted-foreground">{{ t("settings.authProvidersDescription") }}</p>

    <div v-for="provider in providers" :key="provider.id" class="rounded-md border border-border/60 p-3 space-y-2" :data-testid="`auth-provider-${provider.id}`">
      <div class="flex items-center gap-2">
        <span class="font-medium text-sm">{{ provider.label }}</span>
        <span class="rounded bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">{{ provider.kind }}</span>
        <span v-if="provider.source === 'env'" class="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600"> <ShieldAlert class="h-3 w-3" /> env </span>
        <span v-else class="text-xs" :class="provider.enabled ? 'text-green-500' : 'text-muted-foreground'">
          {{ provider.enabled ? t("settings.authProvidersEnabled") : t("settings.authProvidersDisabled") }}
        </span>
        <div class="ml-auto flex items-center gap-1">
          <Button
            v-if="provider.source === 'db'"
            variant="outline"
            size="sm"
            class="h-7"
            @click="
              editingDraft = draftFromView(provider);
              editingIsNew = false;
            "
          >
            {{ t("common.edit") }}
          </Button>
          <Button v-if="provider.source === 'db'" variant="outline" size="sm" class="h-7" @click="toggleEnabled(provider)">
            {{ provider.enabled ? t("settings.authProvidersDisable") : t("settings.authProvidersEnable") }}
          </Button>
          <Button v-if="provider.source === 'db'" variant="outline" size="sm" class="h-7 text-destructive hover:text-destructive" @click="removeProvider(provider)">
            <Trash2 class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{{ provider.id }}</p>
    </div>

    <div v-if="!editingDraft" class="flex gap-2">
      <Button
        variant="outline"
        size="sm"
        class="gap-1.5"
        data-testid="auth-provider-add-ldap"
        @click="
          editingDraft = newDraft('ldap');
          editingIsNew = true;
        "
      >
        <Plus class="h-3.5 w-3.5" /> LDAP
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="gap-1.5"
        data-testid="auth-provider-add-http"
        @click="
          editingDraft = newDraft('http_callback');
          editingIsNew = true;
        "
      >
        <Plus class="h-3.5 w-3.5" /> {{ t("settings.authProvidersHttpCallback") }}
      </Button>
    </div>

    <div v-else class="rounded-md border border-border/60 p-4 space-y-3" data-testid="auth-provider-form">
      <div class="flex items-center justify-between">
        <Label class="text-sm font-medium">{{ editingIsNew ? t("settings.authProvidersAddTitle") : t("settings.authProvidersEditTitle") }}</Label>
        <Button variant="ghost" size="sm" class="h-7" @click="editingDraft = null">{{ t("common.cancel") }}</Button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <Label class="text-xs">{{ t("settings.authProvidersId") }}</Label>
          <Input v-model="draft.id" :disabled="!editingIsNew" class="h-8" data-testid="auth-provider-id" />
        </div>
        <div class="space-y-1">
          <Label class="text-xs">{{ t("settings.authProvidersLabel") }}</Label>
          <Input v-model="draft.label" class="h-8" />
        </div>
      </div>
      <div class="space-y-1">
        <Label class="text-xs">{{ t("settings.authProvidersUrl") }}</Label>
        <Input v-model="draft.url" class="h-8" :placeholder="draft.kind === 'ldap' ? 'ldaps://ldap.corp:636' : 'https://auth.corp/callback'" />
      </div>

      <template v-if="draft.kind === 'ldap'">
        <div class="flex items-center gap-2">
          <input id="auth-provider-starttls" v-model="draft.start_tls" type="checkbox" class="h-3.5 w-3.5" />
          <Label for="auth-provider-starttls" class="text-xs">{{ t("settings.authProvidersStartTls") }}</Label>
        </div>
        <div class="space-y-1">
          <Label class="text-xs">{{ t("settings.authProvidersBaseDn") }}</Label>
          <Input v-model="draft.base_dn" class="h-8" placeholder="dc=corp,dc=example,dc=com" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersBindDn") }}</Label>
            <Input v-model="draft.bind_dn" class="h-8" />
          </div>
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersBindPassword") }}</Label>
            <Input v-model="draft.bind_password" type="password" class="h-8" :placeholder="draft.existing_secrets.includes('bind_password') ? t('settings.authProvidersSecretKeep') : ''" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersUserFilter") }}</Label>
            <Input v-model="draft.user_filter" class="h-8" />
          </div>
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersGroupAttr") }}</Label>
            <Input v-model="draft.group_attr" class="h-8" />
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersUsernameAttr") }}</Label>
            <Input v-model="draft.username_attr" class="h-8" />
          </div>
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersDisplayNameAttr") }}</Label>
            <Input v-model="draft.display_name_attr" class="h-8" />
          </div>
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersEmailAttr") }}</Label>
            <Input v-model="draft.email_attr" class="h-8" />
          </div>
        </div>
      </template>

      <template v-else>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersSharedSecret") }}</Label>
            <Input v-model="draft.shared_secret" type="password" class="h-8" :placeholder="draft.existing_secrets.includes('shared_secret') ? t('settings.authProvidersSecretKeep') : ''" />
          </div>
          <div class="space-y-1">
            <Label class="text-xs">{{ t("settings.authProvidersTimeout") }}</Label>
            <Input v-model.number="draft.timeout_secs" type="number" min="1" max="60" class="h-8" />
          </div>
        </div>
      </template>

      <div class="space-y-1">
        <Label class="text-xs">{{ t("settings.authProvidersRoleMap") }}</Label>
        <textarea v-model="draft.role_map_text" class="w-full h-16 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs" data-testid="auth-provider-role-map"></textarea>
        <p class="text-xs text-muted-foreground">{{ t("settings.authProvidersRoleMapHint") }}</p>
      </div>
      <div class="space-y-1">
        <Label class="text-xs">{{ t("settings.authProvidersDefaultRole") }}</Label>
        <select v-model="draft.default_role" class="h-8 rounded-md border border-border/60 bg-background px-2 text-sm" data-testid="auth-provider-default-role">
          <option value="member">{{ t("settings.authProvidersRoleMember") }}</option>
          <option value="admin">{{ t("settings.authProvidersRoleAdmin") }}</option>
        </select>
      </div>

      <p v-if="message" class="text-xs" :class="messageIsError ? 'text-destructive' : 'text-green-500'">{{ message }}</p>
      <div class="flex gap-2">
        <Button size="sm" class="h-8" :disabled="!canSaveDraft || saving" data-testid="auth-provider-save" @click="saveDraft">
          {{ t("common.save") }}
        </Button>
        <Button variant="outline" size="sm" class="h-8" :disabled="testing" data-testid="auth-provider-test" @click="testDraft">
          <Loader2 v-if="testing" class="h-3.5 w-3.5 animate-spin mr-1" />
          {{ t("settings.authProvidersTest") }}
        </Button>
      </div>
    </div>

    <p v-if="message && !editingDraft" class="text-xs" :class="messageIsError ? 'text-destructive' : 'text-green-500'">{{ message }}</p>
  </div>
</template>
