<template>
  <div class="flex flex-col h-full">
    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
      <span v-if="baseDn" class="text-xs font-mono text-muted-foreground truncate flex-1 min-w-0" :title="baseDn">{{ baseDn }}</span>
      <span v-if="baseDn" class="text-xs text-muted-foreground shrink-0">Copy as:</span>
      <Button v-if="baseDn" variant="outline" size="sm" class="h-6 px-2 text-xs font-mono" :title="t('ldap.copyLdapsearchTooltip')" @click="copyAsLdapSearch"> <Copy class="size-3 mr-1" />ldapsearch </Button>
      <Button v-if="baseDn" variant="outline" size="sm" class="h-6 px-2 text-xs font-mono" :title="t('ldap.copyGetAdObjectTooltip')" @click="copyAsPowershellGetAdObject"> <Copy class="size-3 mr-1" />Get-ADObject </Button>
      <span v-if="copiedFlash" class="text-xs text-green-600 dark:text-green-400">Copied</span>
    </div>

    <!-- Detail panel -->
    <div class="flex-1 min-w-0 overflow-auto p-4">
      <div v-if="entryDetailLoading" class="flex items-center justify-center h-full">
        <Loader2 class="size-5 animate-spin text-muted-foreground" />
      </div>
      <div v-else-if="!entryDetail" class="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <FileSearch class="size-10 opacity-20" />
        <p class="text-sm">Select an entry to view its attributes</p>
      </div>
      <div v-else class="space-y-4">
        <div>
          <h3 class="text-sm font-semibold mb-1">DN</h3>
          <p class="text-sm font-mono bg-muted rounded px-2 py-1 break-all">{{ entryDetail.dn }}</p>
        </div>
        <div>
          <h3 class="text-sm font-semibold mb-2">Attributes</h3>
          <div class="border rounded-md overflow-hidden">
            <table class="w-full text-sm">
              <thead class="bg-muted/50">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium w-48">Name</th>
                  <th class="text-left px-3 py-1.5 font-medium">Value</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="(value, name) in entryDetail.attributes" :key="name" class="hover:bg-muted/30">
                  <td class="px-3 py-1 font-mono text-xs whitespace-nowrap align-top">{{ name }}</td>
                  <td class="px-3 py-1 font-mono text-xs max-w-md">
                    <span :class="{ 'cursor-pointer hover:text-primary hover:underline': isLongValue(value) }" @click="isLongValue(value) && openValuePopup(name, value)">{{ formatCellValue(value) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Value Popup Dialog -->
    <div v-if="popupOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="popupOpen = false">
      <div class="bg-background border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h3 class="font-semibold text-sm">{{ popupAttrName }}</h3>
          <button class="size-6 flex items-center justify-center rounded hover:bg-muted" @click="popupOpen = false">
            <X class="size-4" />
          </button>
        </div>
        <div class="overflow-auto p-4">
          <template v-if="Array.isArray(popupValues)">
            <div v-for="(v, i) in popupValues" :key="i" class="py-1 px-2 rounded text-xs font-mono break-all hover:bg-muted/50">{{ v }}</div>
          </template>
          <template v-else>
            <div class="text-xs font-mono break-all whitespace-pre-wrap">{{ popupValues }}</div>
          </template>
        </div>
        <div class="px-4 py-2 border-t text-xs text-muted-foreground shrink-0">
          {{ Array.isArray(popupValues) ? `${popupValues.length} value(s)` : `${String(popupValues).length} chars` }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { Loader2, FileSearch, X, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { buildGetAdObjectIdentityCommand, buildLdapSearchByDnCommand } from "@/lib/ldap/ldapSearchSyntax";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  baseDn?: string;
}>();

const connectionStore = useConnectionStore();

const entryDetail = ref<{ dn: string; attributes: Record<string, string | string[]> } | null>(null);
const entryDetailLoading = ref(false);

const popupOpen = ref(false);
const popupAttrName = ref("");
const popupValues = ref<string | string[]>("");

const copiedFlash = ref(false);
let copiedTimer: number | null = null;
function flashCopied() {
  copiedFlash.value = true;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copiedFlash.value = false;
  }, 1500);
}

async function copyAsLdapSearch() {
  if (!props.baseDn) return;
  const config = connectionStore.getConfig(props.connectionId) as any;
  const cmd = buildLdapSearchByDnCommand(props.baseDn, config?.host, config?.port, !!config?.ssl);
  const attrs = entryDetail.value ? Object.keys(entryDetail.value.attributes) : [];
  await copyToClipboard(attrs.length > 0 ? `${cmd} ${attrs.join(" ")}` : cmd);
  flashCopied();
}

async function copyAsPowershellGetAdObject() {
  if (!props.baseDn) return;
  const config = connectionStore.getConfig(props.connectionId) as any;
  const cmd = buildGetAdObjectIdentityCommand(props.baseDn, config?.host);
  await copyToClipboard(cmd);
  flashCopied();
}

function isLongValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 1 || (value.length === 1 && String(value[0]).length > 120);
  return String(value).length > 120;
}

function formatCellValue(value: unknown): string {
  if (Array.isArray(value)) {
    const joined = value.join(", ");
    return joined.length <= 120 ? joined : joined.slice(0, 117) + "...";
  }
  const str = String(value);
  return str.length <= 120 ? str : str.slice(0, 117) + "...";
}

function openValuePopup(name: string, value: unknown) {
  popupAttrName.value = name;
  popupValues.value = Array.isArray(value) ? value : String(value);
  popupOpen.value = true;
}

watch(
  () => props.baseDn,
  async (dn) => {
    if (!dn || !props.connectionId) return;
    entryDetailLoading.value = true;
    try {
      const result = await api.ldapSearch(props.connectionId, dn, "(objectClass=*)", "base");
      if (result.entries.length > 0) entryDetail.value = result.entries[0];
    } catch (_e: unknown) {
      entryDetail.value = null;
    } finally {
      entryDetailLoading.value = false;
    }
  },
  { immediate: true },
);
</script>
