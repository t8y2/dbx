<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { oracleDirectGrantsSql } from "@/lib/database/oracleUserAdmin";
import { oracleGrantSources, oracleObjectGrantSources, oracleSecurityObjectMatches, type OracleSecuritySnapshot } from "@/lib/database/oracleSecurity";

const props = defineProps<{ snapshot: OracleSecuritySnapshot; principal: string }>();
const { t } = useI18n();
const { highlight } = useSqlHighlighter();
const directSql = computed(() => oracleDirectGrantsSql(props.snapshot, props.principal).join("\n"));
const owner = ref("");
const objectName = ref("");
const sources = computed(() => (props.principal ? oracleGrantSources(props.snapshot, props.principal) : { grants: oracleObjectGrantSources(props.snapshot), bounded: false }));
const grants = computed(() => sources.value.grants.filter((row) => (!owner.value && !objectName.value) || oracleSecurityObjectMatches(row.grant, owner.value, objectName.value)));
const memberships = computed(() => props.snapshot.roleGrants.rows.filter((row) => !props.principal || row.grantee === props.principal || row.role === props.principal));
const sections = computed(() => Object.entries(props.snapshot));
const incomplete = computed(() => sources.value.bounded || Object.values(props.snapshot).some((read) => !["ok", "empty"].includes(read.state) || read.visibility === "limited"));
const selectedUser = computed(() => props.snapshot.users.rows.find((row) => row.name === props.principal));
const selectedRole = computed(() => props.snapshot.roles.rows.find((row) => row.name === props.principal));
const stateLabel = (state: string) => t(`oracleSecurity.${{ ok: "loaded", empty: "empty", denied: "denied", unavailable: "unavailable", error: "error", unsupported: "unsupported" }[state] ?? state}`);
</script>

<template>
  <div class="flex h-full flex-col gap-3 text-xs" data-oracle-security>
    <p class="text-muted-foreground">{{ t("oracleSecurity.directSqlNotice") }}</p>
    <p v-if="incomplete" role="status" class="text-muted-foreground">{{ t("oracleSecurity.incomplete") }}</p>
    <p v-if="sources.bounded" role="alert" class="text-destructive">{{ t("oracleSecurity.bounded") }}</p>
    <pre v-if="principal" class="min-h-48 flex-1 whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-5 text-foreground" data-direct-grants v-html="highlight(directSql || t(incomplete ? 'oracleSecurity.incomplete' : 'oracleSecurity.noGrants'))" />
    <details :open="!principal">
      <summary class="cursor-pointer font-medium">{{ t("oracleSecurity.source") }}</summary>
      <p class="my-3 text-muted-foreground">{{ t("oracleSecurity.sourceNotice") }}</p>
      <div class="flex flex-wrap gap-2">
        <Input v-model="owner" class="h-8 w-40 text-xs" :aria-label="t('oracleSecurity.owner')" :placeholder="t('oracleSecurity.owner')" />
        <Input v-model="objectName" class="h-8 w-48 text-xs" :aria-label="t('oracleSecurity.objectName')" :placeholder="t('oracleSecurity.objectName')" />
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b bg-muted/20 text-muted-foreground">
            <tr>
              <th class="p-2 font-medium">{{ t("oracleSecurity.privilege") }}</th>
              <th class="p-2 font-medium">{{ t("oracleSecurity.object") }}</th>
              <th class="p-2 font-medium">{{ t("oracleSecurity.source") }}</th>
              <th class="p-2 font-medium">{{ t("oracleSecurity.grantOption") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in grants" :key="index" class="border-b">
              <td class="p-2">
                {{ row.grant.privilege }}<span class="mt-1 block text-muted-foreground">{{ t(`oracleSecurity.${row.kind}`) }}</span>
              </td>
              <td class="p-2 break-all">{{ "owner" in row.grant ? `${row.grant.owner}.${row.grant.objectName}` : "—" }}{{ "columnName" in row.grant ? `.${row.grant.columnName}` : "" }}</td>
              <td class="p-2">
                {{ t(`oracleSecurity.${row.source}`) }} · {{ row.grant.grantee }}<span v-if="row.rolePath.length" class="mt-1 block text-muted-foreground">{{ row.rolePath.join(" → ") }}</span
                ><span v-if="'grantor' in row.grant" class="mt-1 block text-muted-foreground">grantor: {{ row.grant.grantor || t("oracleSecurity.unknownGrantor") }}</span>
              </td>
              <td class="p-2">{{ t(("adminOption" in row.grant ? row.grant.adminOption : row.grant.grantable) ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!incomplete && !grants.length" class="text-muted-foreground">{{ t("oracleSecurity.noGrants") }}</p>
      <details class="border-b pb-3">
        <summary class="cursor-pointer font-medium">{{ t("oracleSecurity.memberships") }} · {{ memberships.length }}</summary>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr>
                <th class="p-2">{{ t("oracleSecurity.grantee") }}</th>
                <th>{{ t("oracleSecurity.role") }}</th>
                <th>ADMIN OPTION</th>
                <th>DEFAULT ROLE</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in memberships" :key="index" class="border-b">
                <td class="p-2">{{ row.grantee }}</td>
                <td>{{ row.role }}</td>
                <td>{{ t(row.adminOption ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
                <td>{{ row.defaultRole === undefined ? t("oracleSecurity.unknown") : t(row.defaultRole ? "oracleSecurity.yes" : "oracleSecurity.no") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary class="cursor-pointer font-medium">{{ t("oracleSecurity.readDetails") }}</summary>
        <p class="mt-3 leading-5 text-muted-foreground">{{ t("oracleSecurity.notice") }}</p>
        <p v-if="selectedUser?.profile" class="mt-3">PROFILE: {{ selectedUser.profile }}</p>
        <p v-if="selectedRole" class="mt-3">PASSWORD_REQUIRED: {{ selectedRole.authentication || t("oracleSecurity.unknown") }}</p>
        <div v-for="[name, result] in sections" :key="name" class="mt-3 border-t pt-3" :data-security-state="result.state">
          <p>{{ t(`oracleSecurity.${name}`) }} · {{ stateLabel(result.state) }} · {{ result.rows.length }} · {{ result.visibility === "complete" ? t("oracleSecurity.full") : t("oracleSecurity.limited") }}{{ result.truncated ? t("oracleSecurity.truncated") : "" }}</p>
          <p v-if="result.message" class="mt-2 whitespace-pre-wrap text-destructive">{{ result.message }}</p>
          <pre class="mt-2 overflow-auto whitespace-pre-wrap text-muted-foreground">{{ result.source }}</pre>
        </div>
      </details>
    </details>
  </div>
</template>
